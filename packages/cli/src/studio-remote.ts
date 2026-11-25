import { randomUUID } from "node:crypto";
import { Cloud } from "@pso/deploy";
import { apply, loadContract, plan, redact } from "@pso/infra";
import { INFRA_HOOKS } from "./commands-infra.ts";
import { RemoteHost, inspectHost } from "./remote-host.ts";
import { activate, deployRemote, remoteContext, remoteLogs, remoteStatus } from "./remote-deploy.ts";

/**
 * Studio: registered hosts and remote deployments. Reads are routine (no confirmation); deploy, rollback and unlock need Studio started with
 * --ops and a typed confirmation, and run as a background job whose progress the page polls. Connections are described by reference only:
 * no key, passphrase or password ever reaches the page.
 */
type R = { status: number; body: unknown };
const ok = (body: unknown): R => ({ status: 200, body });
const bad = (status: number, error: string, hint?: string): R => ({ status, body: { error, ...(hint ? { hint } : {}) } });
interface Job { id: string; kind: string; env: string; state: "running" | "succeeded" | "failed"; lines: string[]; startedAt: string; endedAt?: string; result?: unknown; error?: string }

export class StudioRemote {
  private readonly root: string;
  private readonly ops: boolean;
  private readonly jobs = new Map<string, Job>();
  constructor(o: { root: string; ops: boolean }) { this.root = o.root; this.ops = o.ops; }

  hosts(): R {
    try {
      const cloud = new Cloud();
      const { contract } = loadContract(this.root);
      const envs = Object.entries(contract.environments).filter(([, e]) => e.deploy?.target === "ssh").map(([name, e]) => ({ name, kind: e.kind, connection: e.deploy!.connection!, root: e.deploy!.root ?? "/srv/pso" }));
      return ok({ opsEnabled: this.ops, connections: cloud.list(), environments: envs, jobs: [...this.jobs.values()].map((j) => ({ id: j.id, kind: j.kind, env: j.env, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt ?? null })) });
    } catch (e) { return bad(500, redact((e as Error).message)); }
  }
  host(name: string, root?: string): R {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) return bad(400, "invalid connection name");
    try { return ok(inspectHost(new RemoteHost(name), root ?? "/srv/pso")); } catch (e) { return bad(502, redact((e as Error).message)); }
  }
  environment(env: string): R {
    try {
      const p = plan(this.root, env, INFRA_HOOKS);
      const rc = remoteContext(p);
      return ok({ environment: env, host: rc.host.name, facts: rc.facts, findings: rc.findings, status: remoteStatus(rc, p.topology) });
    } catch (e) { return bad(502, redact((e as Error).message)); }
  }
  logs(env: string, service: string, tail: number): R {
    try { const p = plan(this.root, env, INFRA_HOOKS); return ok({ service, lines: remoteLogs(remoteContext(p), p.topology, service, tail).split(/\r?\n/).filter(Boolean) }); }
    catch (e) { return bad(502, redact((e as Error).message)); }
  }
  job(id: string): R { const j = this.jobs.get(id); return j ? ok(j) : bad(404, "unknown job"); }

  operate(b: Record<string, unknown>): R {
    if (!this.ops) return bad(403, "operations are disabled", "Start Studio with --ops to deploy and roll back from this page");
    const action = String(b["action"] ?? ""), env = String(b["env"] ?? "");
    if (!["deploy", "rollback", "unlock"].includes(action)) return bad(400, "action must be deploy, rollback or unlock");
    if (!/^[a-z][a-z0-9-]*$/.test(env)) return bad(400, "invalid environment");
    if (b["confirm"] !== `${action} ${env}`) return bad(400, `confirmation required: type "${action} ${env}"`);
    if ([...this.jobs.values()].some((j) => j.env === env && j.state === "running")) return bad(409, `an operation on "${env}" is already running`);
    const job: Job = { id: randomUUID(), kind: action, env, state: "running", lines: [], startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    const log = (l: string) => { job.lines.push(redact(l)); if (job.lines.length > 2000) job.lines.shift(); };
    void (async () => {
      try {
        let p = plan(this.root, env, INFRA_HOOKS);
        const rc = remoteContext(p);
        if (action === "deploy") {
          if (p.summary.changes) { apply(this.root, { env, hooks: INFRA_HOOKS, by: "pso studio" }); p = plan(this.root, env, INFRA_HOOKS); log("infrastructure configuration updated"); }
          const r = await deployRemote(this.root, p, rc, log);
          job.result = r;
          if (!r.activated) throw new Error(`release ${r.release} failed and ${r.rolledBackTo} was started again (database migrations are not reverted)`);
          log(`release ${r.release} is active and verified`);
        } else if (action === "rollback") {
          const st = remoteStatus(rc, p.topology);
          const idx = st.current ? st.releases.indexOf(st.current) : -1;
          const to = typeof b["to"] === "string" ? b["to"] : idx > 0 ? st.releases[idx - 1] : undefined;
          if (!to) throw new Error("no earlier release to start again");
          await activate(rc, p.topology, to, log);
          log(`release ${to} started again (database migrations are not reverted)`);
          job.result = { activated: to };
        } else {
          rc.host.exec(`rm -rf '${rc.dir}/.deploy-lock'`);
          log("lock removed");
        }
        job.state = "succeeded";
      } catch (e) { job.state = "failed"; job.error = redact((e as Error).message); log(`error: ${job.error}`); }
      finally { job.endedAt = new Date().toISOString(); }
    })();
    return ok({ job: job.id });
  }
}
