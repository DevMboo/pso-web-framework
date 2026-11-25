import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  INFRA_FILE, apply, compose, composeSync, composeTarget, dockerReady, hostsBlockPresent, hostsMarker, loadContract, plan, ps, readState, redact, renderHosts, startupOrder, systemHostsFile, validate,
} from "@pso/infra";
import { INFRA_HOOKS } from "./commands-infra.ts";
import { envDeployPlan, releasesOf } from "./deploy-env.ts";

/**
 * Studio's infrastructure console. Reads come from the same engine the CLI uses (plans, topology, validation, `docker compose ps`).
 * Operations (provision, repair, rotate, start, stop, restart) exist only when Studio was started with --ops; each one needs an explicit
 * `confirm` equal to the action and target, and runs exactly what the corresponding `pso` command runs. Nothing returned here ever
 * contains key material or a secret value: certificates are described by fingerprint, names and dates; secrets by source and length.
 */
type R = { status: number; body: unknown };
const ok = (body: unknown): R => ({ status: 200, body });
const bad = (status: number, error: string, hint?: string): R => ({ status, body: { error, ...(hint ? { hint } : {}) } });

export class StudioInfra {
  private readonly root: string;
  readonly opsEnabled: boolean;
  constructor(o: { root: string; ops: boolean }) { this.root = o.root; this.opsEnabled = o.ops; }

  private declared(): boolean { return existsSync(join(this.root, INFRA_FILE)); }

  environments(): R {
    const { contract, declared, issues } = loadContract(this.root);
    const st = readState(this.root);
    return ok({ declared, opsEnabled: this.opsEnabled, issues, environments: Object.entries(contract.environments).map(([name, e]) => ({ name, kind: e.kind, domain: e.domain, runtime: e.runtime ?? "process", tls: e.tls?.source ?? (e.kind === "development" ? "pso-dev-ca" : "external"), secrets: e.secrets?.provider ?? (e.kind === "development" ? "local" : "env"), lastApply: st.environments[name]?.lastApply ?? null, default: (contract.defaultEnvironment ?? Object.keys(contract.environments)[0]) === name })) });
  }

  infra(env?: string): R {
    try {
      const p = plan(this.root, env, INFRA_HOOKS);
      const t = p.topology;
      return ok({
        environment: p.environment, kind: p.kind, declared: p.declared, summary: p.summary, interrupted: p.interrupted,
        topology: { domain: t.domain, httpsPort: t.httpsPort, runtime: t.runtime, tls: t.tlsSource, secrets: t.secretProvider, project: t.project, api: t.api, publicHosts: t.publicHosts,
          identity: t.identity ? { provider: t.identity.provider, issuer: t.identity.issuer, audience: t.identity.audience, jwksContainer: t.identity.jwksContainer, jwksHost: t.identity.jwksHost, users: t.identity.users.map((u) => ({ username: u.username, scopes: u.scopes })), scopes: t.identity.scopes } : null,
          frontends: t.frontends.map((f) => ({ name: f.name, url: f.url, host: f.host, basePath: f.basePath, auth: f.auth, clientId: f.clientId, redirectUris: f.redirectUris, webOrigins: f.webOrigins, microfrontends: f.info.microfrontends })),
          services: t.services.map((s) => ({ name: s.name, role: s.role, runtime: s.runtime, port: s.port, prefix: s.prefix, mtls: s.mtls, db: s.db, containerUrl: s.containerUrl, hostUrl: s.hostUrl, dependsOn: s.dependsOn })) },
        resources: p.resources.map((r) => ({ id: r.id, kind: r.kind, module: r.module, owner: r.owner, description: r.description, status: r.status, action: r.action, reasons: r.reasons, warnings: r.warnings, files: r.files.map((f) => ({ path: f.path, sensitive: f.sensitive })), facts: r.facts, affects: r.affects })),
      });
    } catch (e) { return bad(422, redact((e as Error).message)); }
  }

  async validate(env?: string, probe = false): Promise<R> {
    try { const v = await validate(this.root, { ...(env ? { env } : {}), probe, hooks: INFRA_HOOKS }); return ok({ ok: v.ok, environment: v.environment, findings: v.findings, probes: v.probes }); }
    catch (e) { return bad(422, redact((e as Error).message)); }
  }

  certificates(env?: string): R {
    try {
      const p = plan(this.root, env, INFRA_HOOKS);
      const rows = p.resources.filter((r) => r.kind === "ca" || r.kind === "certificate" || r.kind === "secret" || r.kind === "signing-key").map((r) => ({ id: r.id, kind: r.kind, owner: r.owner, description: r.description, status: r.status, reasons: r.reasons, warnings: r.warnings,
        fingerprint: r.facts["fingerprint"] ?? null, notAfter: r.facts["notAfter"] ?? null, daysLeft: r.facts["daysLeft"] ?? null, names: typeof r.facts["names"] === "string" ? String(r.facts["names"]).split(",") : [], source: r.facts["source"] ?? null, length: r.facts["length"] ?? null,
        files: r.files.map((f) => ({ path: f.path, sensitive: f.sensitive })) }));
      return ok({ environment: p.environment, kind: p.kind, rows });
    } catch (e) { return bad(422, redact((e as Error).message)); }
  }

  hosts(env?: string): R {
    try {
      const p = plan(this.root, env, INFRA_HOOKS);
      const t = p.topology;
      const { config } = { config: { name: p.workspace } };
      const file = systemHostsFile();
      return ok({ environment: p.environment, kind: p.kind, domain: t.domain, httpsPort: t.httpsPort, dns: t.decl.dns?.provider ?? "none",
        hosts: [...t.frontends.map((f) => ({ host: f.host, role: `frontend ${f.name}`, url: f.url })), { host: t.api.host, role: "API (orchestrator through the edge)", url: t.api.origin }, ...(t.identity && t.identity.provider !== "external" ? [{ host: t.identity.host, role: `identity provider (${t.identity.provider})`, url: t.identity.issuer }] : [])],
        internal: t.services.map((s) => ({ name: s.name, container: s.containerUrl, process: s.hostUrl })),
        hostsFile: p.kind === "development" ? { file, present: hostsBlockPresent(file, hostsMarker(config.name, p.environment)), block: renderHosts(t, config.name) } : null,
        note: p.kind === "development" ? `Browsers resolve *.localhost to this machine; other clients need the hosts block (pso infra:hosts --apply --yes, administrator rights).` : `PSO never creates DNS records: create ${t.publicHosts.join(", ")} at your DNS provider.` });
    } catch (e) { return bad(422, redact((e as Error).message)); }
  }

  containers(env?: string): R {
    try {
      const p = plan(this.root, env, INFRA_HOOKS);
      const t = p.topology;
      const d = dockerReady();
      let rows: ReturnType<typeof ps> = [], generated = true;
      if (d.ok) { try { rows = ps(composeTarget(this.root, t)); } catch { generated = false; } }
      return ok({ environment: p.environment, docker: d, generated, order: startupOrder(t), containers: rows, opsEnabled: this.opsEnabled });
    } catch (e) { return bad(422, redact((e as Error).message)); }
  }

  logs(env: string | undefined, name: string, tail: number): R {
    try {
      const p = plan(this.root, env, INFRA_HOOKS);
      if (!startupOrder(p.topology).includes(name)) return bad(404, `unknown container "${name}"`);
      const r = composeSync(composeTarget(this.root, p.topology), ["logs", "--no-color", "--tail", String(Math.min(Math.max(tail, 1), 2000)), name], 30_000);
      return ok({ name, lines: redact(r.stdout + r.stderr).split(/\r?\n/).filter(Boolean).slice(-2000) });
    } catch (e) { return bad(422, redact((e as Error).message)); }
  }

  deployment(env?: string): R {
    try { const { d } = envDeployPlan(this.root, env ?? plan(this.root, undefined, INFRA_HOOKS).environment); return ok({ ...d, releases: releasesOf(this.root, d.environment) }); }
    catch (e) { return bad(422, redact((e as Error).message)); }
  }

  /** POST /api/ops/infra and /api/ops/containers (only with --ops). */
  async operate(kind: "infra" | "containers", b: Record<string, unknown>): Promise<R> {
    if (!this.opsEnabled) return bad(403, "operations are disabled", "Start Studio with --ops to provision, repair and run containers from this page");
    if (!this.declared()) return bad(409, `${INFRA_FILE} does not exist`, "Create it with pso infra:init");
    const action = String(b["action"] ?? ""), env = typeof b["env"] === "string" ? b["env"] : undefined;
    const p = (() => { try { return plan(this.root, env, INFRA_HOOKS); } catch (e) { return e as Error; } })();
    if (p instanceof Error) return bad(422, redact(p.message));
    const target = kind === "infra" ? (typeof b["resource"] === "string" ? b["resource"] : p.environment) : (Array.isArray(b["services"]) && b["services"].length ? (b["services"] as string[]).join(",") : p.environment);
    // the typed confirmation names the action and its target: a click alone never changes infrastructure
    if (b["confirm"] !== `${action} ${target}`) return bad(400, `confirmation required: type "${action} ${target}"`);
    if (kind === "infra") {
      if (p.kind !== "development" && b["acknowledgeEnvironment"] !== p.environment) return bad(400, `"${p.environment}" is a ${p.kind} environment: acknowledge it explicitly`);
      try {
        if (action === "apply") { const r = apply(this.root, { env: p.environment, hooks: INFRA_HOOKS, by: "pso studio" }); return ok({ applied: r.applied, restart: r.restart, summary: r.plan.summary }); }
        if (action === "repair") { const r = apply(this.root, { env: p.environment, hooks: INFRA_HOOKS, repair: true, by: "pso studio" }); return ok({ applied: r.applied, backups: r.backups, restart: r.restart, summary: r.plan.summary }); }
        if (action === "rotate") {
          const res = p.resources.find((x) => x.id === b["resource"]);
          if (!res || !["ca", "certificate", "secret", "signing-key"].includes(res.kind) || res.owner !== "pso") return bad(400, "only PSO-owned key material can be rotated");
          const r = apply(this.root, { env: p.environment, hooks: INFRA_HOOKS, rotate: [res.id], by: "pso studio" }); return ok({ applied: r.applied, restart: r.restart });
        }
      } catch (e) { return bad(409, redact((e as Error).message)); }
      return bad(400, "action must be apply, repair or rotate");
    }
    const d = dockerReady(); if (!d.ok) return bad(409, `Docker is not usable: ${d.reason}`);
    const names = Array.isArray(b["services"]) ? (b["services"] as unknown[]).map(String) : [];
    const known = startupOrder(p.topology);
    for (const n of names) if (!known.includes(n)) return bad(400, `unknown container "${n}"`);
    if (p.summary.changes > 0 && action === "up") return bad(409, `the infrastructure of "${p.environment}" has ${p.summary.changes} pending change(s)`, "Provision it first (Infrastructure > Apply)");
    const c = composeTarget(this.root, p.topology);
    const lines: string[] = [];
    const args = action === "up" ? ["up", "-d", "--wait", "--wait-timeout", "300", ...names] : action === "stop" ? ["stop", ...names] : action === "restart" ? (names.length ? ["restart", ...names] : null) : action === "down" ? ["down", "--remove-orphans"] : null;
    if (!args) return bad(400, "action must be up, stop, restart (with services) or down (volumes are always kept here)");
    const code = await compose(c, args, { onLine: (l) => lines.push(redact(l)) });
    return ok({ ok: code === 0, exitCode: code, output: lines.slice(-200), containers: ps(c) });
  }
}
