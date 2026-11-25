import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type WorkspaceConfig } from "@pso/core";
import {
  INFRA_FILE, InfraError, apply, applyHostsBlock, defaultContract, developmentUserToken, hostsBlockPresent, hostsMarker, loadContract, mintDevToken, plan, readFrontends,
  readState, renderHosts, systemHostsFile, validate, applyIdentity, planIdentity, environmentCa, localResolution,
  type AdminAccess, type ApplyResult, type EngineHooks, type IdentityChange, type InfraContract, type Plan, type PlannedResource, type Topology,
} from "@pso/infra";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, json, requireWorkspace, type Command, type Ctx } from "./commands.ts";
import { routeRows } from "./http-static.ts";

/**
 * How the infrastructure engine reads what the identity provider must know: the frontends (statically, through their contracts) and the
 * scopes the declarations use, those of the frontends AND of the orchestrator's routes (read statically, in either structure), so a
 * development user with every scope holds what the API requires even in a workspace without a frontend.
 */
export const INFRA_HOOKS: EngineHooks = {
  frontends: (root: string, ws: WorkspaceConfig) => {
    const fe = readFrontends(root, ws);
    const orch = ws.services.find((s) => s.role === "orchestrator");
    let routeScopes: string[] = [];
    if (orch) { try { routeScopes = routeRows(join(root, ...orch.path.split("/"))).flatMap((r) => r.scopes); } catch { /* an unreadable registry is reported by pso validate, not here */ } }
    return { frontends: fe.frontends, scopes: [...new Set([...fe.scopes, ...routeScopes])].sort() };
  },
};

/** Runs an engine call and turns its refusals into CLI errors (exit 1, with the hint). */
export function engine<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof InfraError) throw new CliError(e.message, e.hint); throw e; }
}
export async function engineAsync<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof InfraError) throw new CliError(e.message, e.hint); throw e; }
}

const envFlag = (ctx: Ctx): string | undefined => str(ctx.flags["env"]);
const by = () => process.env["USERNAME"] ?? process.env["USER"] ?? "pso";

const STATUS_MARK: Record<string, string> = { ok: "ok", missing: "MISSING", invalid: "INVALID", outdated: "outdated", drifted: "DRIFT", exposed: "EXPOSED", "external-ok": "external", "external-missing": "MISSING (external)", "external-unverified": "external?", blocked: "BLOCKED" };
const ACTION_TEXT: Record<string, string> = { none: "", create: "create", replace: "replace", update: "update", protect: "restrict access", repair: "repair (pso infra:repair)", supply: "supply it" };

function planLines(p: Plan, all = false): string[] {
  const rows = p.resources.filter((r) => all || r.action !== "none" || r.warnings.length > 0);
  const byModule = new Map<string, PlannedResource[]>();
  for (const r of rows) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);
  const out = [`environment ${p.environment} (${p.kind}${p.declared ? "" : ", derived: no pso.infra.json"})   runtime ${p.topology.runtime}   tls ${p.topology.tlsSource}   secrets ${p.topology.secretProvider}`];
  for (const [mod, rs] of byModule) {
    out.push(`  ${mod}`);
    for (const r of rs) out.push(`    ${STATUS_MARK[r.status]!.padEnd(18)} ${r.id.padEnd(30)} ${ACTION_TEXT[r.action] ? `-> ${ACTION_TEXT[r.action]}` : ""}${r.reasons.length ? `  (${r.reasons.join("; ")})` : ""}${r.warnings.length ? `  warning: ${r.warnings.join("; ")}` : ""}`);
  }
  if (p.interrupted.length) out.push(`  interrupted earlier: ${p.interrupted.join(", ")} (completed by the next apply)`);
  const s = p.summary;
  out.push(`${s.changes} change(s), ${s.drift} drifted, ${s.blocked} to supply, ${p.resources.length - rows.length} unchanged`);
  return out;
}

function applyLines(r: ApplyResult, dry: boolean): string[] {
  const out = [...r.notes.map((n) => `note: ${n}`)];
  for (const a of r.applied) out.push(`${dry ? "[dry-run] " : ""}${(a.result === "done" ? a.action : a.result).padEnd(10)} ${a.id.padEnd(30)} ${a.result === "done" ? a.files.join(", ") : a.detail}`);
  if (!r.applied.length) out.push("nothing to do: every resource is present and valid");
  if (r.backups.length) out.push(`edited files were kept in: ${r.backups.join(", ")}`);
  if (r.restart.length && !dry) out.push(`restart needed if the stack is running: ${r.restart.join(", ")}   (pso docker:restart ${r.restart.join(" ")} --env ${r.plan.environment})`);
  const refused = r.applied.filter((a) => a.result === "refused");
  if (refused.length) out.push(`${refused.length} resource(s) must be supplied by the operator: PSO never generates them for a ${r.plan.kind} environment`);
  return out;
}

/** Production key material and secrets are never generated, so applying a non-development environment only writes configuration. */
function requireAuthorization(ctx: Ctx, p: Plan, what: string): number | undefined {
  if (p.kind === "development" || ctx.flags["yes"] === true) return undefined;
  emit(ctx, { authorizationRequired: true, environment: p.environment, plan: p.resources.filter((r) => r.action !== "none") }, [...planLines(p), "", `${what} environment "${p.environment}" (${p.kind}) changes files that a deployment will use. Review the plan above, then re-run with --yes.`].join("\n"));
  return 3;
}

export function initContract(ws: WorkspaceConfig, o: { identity: string; runtime: string; users: string[]; mtls?: string[] }): InfraContract {
  const c = defaultContract();
  c.environments["local"]!.runtime = o.runtime as "docker" | "process";
  if (o.identity !== "none") c.identity = { provider: o.identity as "keycloak" | "pso-dev", realm: ws.name, ...(o.users.length ? { users: o.users.map((u) => { const at = u.indexOf(":"); const name = at < 0 ? u : u.slice(0, at), sc = at < 0 ? "" : u.slice(at + 1); return { username: name, scopes: sc ? sc.split("+").filter(Boolean) : ["*"] }; }) } : {}) };
  if (o.mtls?.length) c.services = Object.fromEntries(o.mtls.map((s) => [s, { mtls: true }]));
  return c;
}

export const INFRA_COMMANDS: Record<string, Command> = {
  "infra:init": {
    usage: "pso infra:init [--identity keycloak|pso-dev|none] [--runtime docker|process] [--users ana,bob:catalog:read+cart:write] [--mtls accounts,billing] [--dry-run] [--force] [--json]",
    summary: "Write pso.infra.json, the declarative infrastructure contract (environments, hosts, TLS, secrets, identity provider), derived from the workspace: one local development environment to start with",
    next: "pso infra:plan, then pso infra:apply",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const file = join(root, INFRA_FILE);
      if (existsSync(file) && ctx.flags["force"] !== true) throw new CliError(`${INFRA_FILE} already exists`, "Edit it, or pass --force to replace it");
      const identity = str(ctx.flags["identity"]) ?? "none", runtime = str(ctx.flags["runtime"]) ?? "process";
      if (!["keycloak", "pso-dev", "none"].includes(identity)) throw new CliError(`Unknown --identity "${identity}"`, "Use keycloak (a real OpenID Connect provider in a container), pso-dev (offline development tokens) or none");
      if (runtime !== "docker" && runtime !== "process") throw new CliError(`Unknown --runtime "${runtime}"`, "Use docker or process");
      const users = (str(ctx.flags["users"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      for (const u of users) if (!/^[a-z][a-z0-9._-]{0,63}(:[A-Za-z0-9._:*+-]+)?$/.test(u)) throw new CliError(`Invalid --users entry "${u}"`, "Use name (every scope) or name:scope+scope, for example bob:catalog:read+cart:write");
      const mtls = (str(ctx.flags["mtls"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      for (const m of mtls) if (!config.services.some((s) => s.name === m && s.role !== "orchestrator")) throw new CliError(`--mtls names "${m}", which is not a service of this workspace`);
      const c = initContract(config, { identity, runtime, users, mtls });
      const text = JSON.stringify(c, null, 2) + "\n";
      if (ctx.flags["dry-run"] !== true) writeFileSync(file, text);
      emit(ctx, { dryRun: ctx.flags["dry-run"] === true, file: INFRA_FILE, contract: c }, `${ctx.flags["dry-run"] === true ? "[dry-run] would write" : "wrote"} ${INFRA_FILE}: environment "local" (development, ${c.environments["local"]!.domain}, runtime ${runtime}), identity ${identity}\nnext: pso infra:plan   then   pso infra:apply`);
      return 0;
    },
  },
  "infra:plan": {
    usage: "pso infra:plan [--env <name>] [--all] [--json]",
    summary: "Show what the infrastructure of an environment needs and what applying would do (create, replace, update, supply), without changing anything",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      emit(ctx, p, planLines(p, ctx.flags["all"] === true).join("\n") + "\n\nNothing was changed.");
      return 0;
    },
  },
  "infra:apply": {
    usage: "pso infra:apply [--env <name>] [--only <id,id>] [--dry-run] [--yes] [--json]",
    summary: "Provision the environment idempotently: create what is missing and PSO may generate (development only), update configuration whose declarations changed, keep everything valid, never touch operator-supplied resources or hand edits",
    async run(ctx) {
      const { root } = requireWorkspace(ctx);
      const pre = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const dry = ctx.flags["dry-run"] === true;
      if (!dry) { const a = requireAuthorization(ctx, pre, "Applying"); if (a !== undefined) return a; }
      const only = str(ctx.flags["only"])?.split(",").map((x) => x.trim()).filter(Boolean);
      const r = engine(() => apply(root, { env: pre.environment, hooks: INFRA_HOOKS, dryRun: dry, by: by(), ...(only ? { only } : {}) }));
      emit(ctx, { environment: r.plan.environment, applied: r.applied, restart: r.restart, recovered: r.recovered, notes: r.notes, summary: r.plan.summary }, applyLines(r, dry).join("\n"));
      return r.applied.some((a) => a.result === "refused") && r.plan.resources.some((x) => x.status === "external-missing") ? 1 : 0;
    },
  },
  "infra:repair": {
    usage: "pso infra:repair [--env <name>] [--yes] [--json]",
    summary: "Resolve drift and damage: regenerate managed files that were edited by hand (the edited copy is kept in .infra/backups/), complete interrupted provisioning, restrict exposed key files. Needs --yes when something would be overwritten",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const overwrites = p.resources.filter((r) => r.action === "repair");
      if (overwrites.length && ctx.flags["yes"] !== true) {
        emit(ctx, { authorizationRequired: true, overwrite: overwrites.map((r) => ({ id: r.id, file: r.files[0]?.path, reason: r.reasons.join("; ") })) }, [...overwrites.map((r) => `would regenerate ${r.files[0]?.path} (${r.reasons.join("; ")})`), "", "These files were changed outside PSO. Move the change into the declarations first; re-run with --yes to regenerate them (the edited copies are backed up)."].join("\n"));
        return 3;
      }
      const a = requireAuthorization(ctx, p, "Repairing"); if (a !== undefined) return a;
      const r = engine(() => apply(root, { env: p.environment, hooks: INFRA_HOOKS, repair: true, by: by() }));
      emit(ctx, { environment: r.plan.environment, applied: r.applied, backups: r.backups, restart: r.restart, recovered: r.recovered, summary: r.plan.summary }, applyLines(r, false).join("\n"));
      return 0;
    },
  },
  "infra:rotate": {
    usage: "pso infra:rotate <resource> [--env <name>] --yes [--json]",
    summary: "Replace a valid certificate, authority, signing key or secret on purpose (rotation). Replacing the authority re-issues every certificate it signed. Development environments only: production material is rotated by its owner",
    args: 1,
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const id = ctx.positionals[0];
      if (!id) throw new CliError("Missing resource", "Example: pso infra:rotate cert:edge   (see pso infra:inspect for the ids)");
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const r = p.resources.find((x) => x.id === id);
      if (!r) throw new CliError(`Unknown resource "${id}"`, `Known: ${p.resources.filter((x) => ["ca", "certificate", "secret", "signing-key"].includes(x.kind)).map((x) => x.id).join(", ")}`);
      if (!["ca", "certificate", "secret", "signing-key"].includes(r.kind)) throw new CliError(`${id} is ${r.kind === "config" ? "generated configuration" : `a ${r.kind}`}: only key material is rotated`);
      if (r.owner !== "pso") throw new CliError(`${id} is supplied by the operator in "${p.environment}"`, "Rotate it at its source, then run pso infra:validate");
      if (ctx.flags["yes"] !== true) { emit(ctx, { authorizationRequired: true, resource: id }, `Rotating ${id} replaces it${r.kind === "ca" ? " and re-issues every certificate it signed" : ""}; running containers keep the old material until they restart. Re-run with --yes.`); return 3; }
      const res = engine(() => apply(root, { env: p.environment, hooks: INFRA_HOOKS, rotate: [id], by: by() }));
      emit(ctx, { rotated: id, applied: res.applied, restart: res.restart }, applyLines(res, false).join("\n"));
      return 0;
    },
  },
  "infra:validate": {
    usage: "pso infra:validate [--env <name>] [--probe] [--json]",
    summary: "Validate an environment's infrastructure: integrity of authorities, certificates and keys, expiry, permissions, drift, ignore rules, secrets leaked into files, and with --probe the running environment (TLS, security headers, API readiness, identity provider) for real (exit 1 on errors)",
    async run(ctx) {
      const { root } = requireWorkspace(ctx);
      const v = await engineAsync(() => validate(root, { ...(envFlag(ctx) ? { env: envFlag(ctx)! } : {}), probe: ctx.flags["probe"] === true, hooks: INFRA_HOOKS }));
      const { plan: _p, ...rest } = v;
      emit(ctx, { ...rest, summary: v.plan.summary }, [
        ...v.findings.map((f) => `${f.severity.toUpperCase().padEnd(7)} ${f.code.padEnd(30)} ${f.subject}: ${f.message}${f.hint ? `\n        hint: ${f.hint}` : ""}`),
        ...v.probes.map((x) => `${x.ok ? "ok     " : "FAILED "} probe  ${x.name.padEnd(40)} ${x.detail}${x.timeMs !== undefined ? ` (${x.timeMs} ms)` : ""}`),
        v.ok ? `OK: environment ${v.environment}` : `FAILED: ${v.findings.filter((f) => f.severity === "error").length} error(s) in environment ${v.environment}`,
      ].join("\n"));
      return v.ok ? 0 : 1;
    },
  },
  "infra:inspect": {
    usage: "pso infra:inspect [<resource>] [--env <name>] [--json]",
    summary: "Show the resolved topology of an environment (hosts, origins, OIDC redirect URIs, addresses as containers and as processes see them) and its resources with owner, files and facts (fingerprints, expiry; never key material or secret values)",
    args: 1,
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const t = p.topology;
      const want = ctx.positionals[0];
      if (want) {
        const r = p.resources.find((x) => x.id === want);
        if (!r) throw new CliError(`Unknown resource "${want}"`, `Known: ${p.resources.map((x) => x.id).join(", ")}`);
        const rec = readState(root).environments[p.environment]?.resources[want];
        emit(ctx, { ...r, state: rec ?? null }, [`${r.id}  (${r.kind}, module ${r.module}, owner ${r.owner})`, `  ${r.description}`, `  status: ${r.status}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`, ...r.files.map((f) => `  file:   ${f.path}${f.sensitive ? "  [sensitive: never printed]" : ""}`), ...Object.entries(r.facts).map(([k, v]) => `  ${k}: ${v}`), ...(r.affects.length ? [`  restarts: ${r.affects.join(", ")}`] : []), ...(rec ? [`  provisioned: ${rec.createdAt}${rec.updatedAt !== rec.createdAt ? `, updated ${rec.updatedAt}` : ""}${rec.origin ? ` (${rec.origin})` : ""}`] : [])].join("\n"));
        return 0;
      }
      const topo = { environment: p.environment, kind: t.kind, runtime: t.runtime, domain: t.domain, httpsPort: t.httpsPort, tls: t.tlsSource, secrets: t.secretProvider, project: t.project, publicHosts: t.publicHosts, api: t.api, identity: t.identity ? { provider: t.identity.provider, issuer: t.identity.issuer, audience: t.identity.audience, jwks: { container: t.identity.jwksContainer, host: t.identity.jwksHost }, users: t.identity.users.map((u) => u.username), scopes: t.identity.scopes } : null, frontends: t.frontends.map((f) => ({ name: f.name, url: f.url, auth: f.auth, clientId: f.clientId, redirectUris: f.redirectUris, webOrigins: f.webOrigins, microfrontends: f.info.microfrontends })), services: t.services.map((s) => ({ name: s.name, role: s.role, port: s.port, mtls: s.mtls, db: s.db, container: s.containerUrl, host: s.hostUrl })) };
      emit(ctx, { topology: topo, resources: p.resources }, [
        `environment ${p.environment} (${t.kind})  domain ${t.domain}  https port ${t.httpsPort}  runtime ${t.runtime}  compose project ${t.project}`,
        `api        ${t.api.origin}`,
        ...(t.identity ? [`identity   ${t.identity.provider}  issuer ${t.identity.issuer}  audience ${t.identity.audience}`, `           jwks (containers) ${t.identity.jwksContainer}`, `           jwks (processes)  ${t.identity.jwksHost}`] : ["identity   none"]),
        ...t.frontends.flatMap((f) => [`frontend   ${f.name.padEnd(18)} ${f.url}  (${f.auth}${f.auth === "oidc" ? `, client ${f.clientId}` : ""}, ${f.info.microfrontends.length} MEI)`, ...(f.auth === "oidc" ? [`           redirect URIs: ${f.redirectUris.join(", ")}`] : [])]),
        ...t.services.map((s) => `service    ${s.name.padEnd(18)} container ${s.containerUrl.padEnd(28)} process ${s.hostUrl}${s.mtls ? "  (mutual TLS)" : ""}${s.db ? "  (database)" : ""}`),
        "", ...planLines(p, true),
      ].join("\n"));
      return 0;
    },
  },
  "infra:status": {
    usage: "pso infra:status [--env <name>] [--json]",
    summary: "One-screen health of an environment's infrastructure: resources by status, drift, certificates close to expiry, the last provisioning and whether one was interrupted",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const st = readState(root).environments[p.environment];
      const expiring = p.resources.filter((r) => r.kind === "certificate" || r.kind === "ca").filter((r) => typeof r.facts["daysLeft"] === "number").map((r) => ({ id: r.id, daysLeft: r.facts["daysLeft"] as number })).sort((a, b) => a.daysLeft - b.daysLeft);
      const healthy = p.summary.changes === 0 && p.summary.drift === 0 && p.summary["external-missing"] === 0 && p.interrupted.length === 0;
      emit(ctx, { environment: p.environment, healthy, summary: p.summary, lastApply: st?.lastApply ?? null, interrupted: p.interrupted, certificates: expiring }, [
        `${p.environment}: ${healthy ? "healthy" : "needs attention"}`,
        `  ${p.resources.length} resources: ${Object.entries(p.summary).filter(([k, v]) => v && !["changes", "drift", "blocked"].includes(k)).map(([k, v]) => `${v} ${k}`).join(", ")}`,
        `  last apply: ${st?.lastApply ? `${st.lastApply.at} by ${st.lastApply.by} (${st.lastApply.changed} change(s))` : "never"}`,
        ...(p.interrupted.length ? [`  interrupted: ${p.interrupted.join(", ")}`] : []),
        ...(expiring.length ? [`  nearest certificate expiry: ${expiring[0]!.id} in ${expiring[0]!.daysLeft} day(s)`] : []),
        ...(healthy ? [] : [`  next: ${p.summary.drift ? "pso infra:repair" : "pso infra:apply"} --env ${p.environment}`]),
      ].join("\n"));
      return healthy ? 0 : 1;
    },
  },
  "infra:hosts": {
    usage: "pso infra:hosts [--env <name>] [--apply | --remove] [--file <hosts-file>] [--yes] [--json]",
    summary: "Show the hosts entries a development environment needs; with --apply (or --remove) and --yes write (or remove) PSO's marked block in the hosts file, nothing else (the system file needs administrator rights). Browsers resolve *.localhost without it",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      if (p.kind !== "development") throw new CliError(`"${p.environment}" is a ${p.kind} environment: its names need real DNS records`, "PSO never creates DNS records; create them at your DNS provider (pso infra:inspect lists the hosts)");
      const block = renderHosts(p.topology, config.name), m = hostsMarker(config.name, p.environment);
      const file = str(ctx.flags["file"]) ?? systemHostsFile();
      const change = ctx.flags["apply"] === true ? "apply" : ctx.flags["remove"] === true ? "remove" : undefined;
      if (!change) { emit(ctx, { file, present: hostsBlockPresent(file, m), block }, `${block}\n${hostsBlockPresent(file, m) ? `present in ${file}` : `not in ${file}. Chrome, Edge and Firefox resolve *.localhost to this machine without it; other clients need it: pso infra:hosts --apply --yes`}`); return 0; }
      if (ctx.flags["yes"] !== true) { emit(ctx, { authorizationRequired: true, file, block }, `Would ${change === "apply" ? "write" : "remove"} PSO's block in ${file}:\n${block}\nRe-run with --yes.`); return 3; }
      const r = engine(() => applyHostsBlock(file, block, m, change === "remove"));
      emit(ctx, { file, changed: r.changed, backup: r.backup ?? null }, r.changed ? `${change === "apply" ? "wrote" : "removed"} PSO's block in ${file}${r.backup ? ` (previous file: ${r.backup})` : ""}` : `${file} already ${change === "apply" ? "has" : "lacks"} PSO's block: nothing changed`);
      return 0;
    },
  },
  "infra:identity": {
    usage: "pso infra:identity [--env <name>] [--apply] [--prune] [--yes] [--json]",
    summary: "Reconcile the environment's running Keycloak realm with the declarations through its administration API: FEI clients, redirect URIs, web origins, the service client, scope roles, mappers and development users. Without --apply it reports drift; changing an existing managed client or removing one (--prune) needs --yes. Users, credentials, sessions, client secrets and resources PSO did not create are never changed",
    async run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const t = p.topology;
      if (t.identity?.provider !== "keycloak") throw new CliError(`environment "${p.environment}" does not use a PSO-managed Keycloak`, "Declare identity.provider \"keycloak\" in pso.infra.json");
      const access = identityAccess(root, t);
      if (ctx.flags["apply"] !== true) {
        const ip = await engineAsync(() => planIdentity(root, t, access));
        emit(ctx, ip, [`realm ${ip.realm} (${ip.reachable ? "reachable" : "NOT reachable"}): ${ip.inSync ? "in sync with the declarations" : `${ip.changes.length} difference(s)`}`, ...ip.changes.map(changeLine), "", "Nothing was changed. Apply with --apply (sensitive changes also need --yes)."].join("\n"));
        return ip.reachable ? 0 : 1;
      }
      const r = await engineAsync(() => applyIdentity(root, t, access, { authorizeSensitive: ctx.flags["yes"] === true, prune: ctx.flags["prune"] === true }));
      const waiting = r.skipped.filter((c) => c.kind !== "external-conflict");
      emit(ctx, r, [...r.applied.map((c) => `applied  ${changeLine(c)}`), ...r.skipped.map((c) => `skipped  ${changeLine(c)}`), r.applied.length ? `realm ${r.plan.realm} reconciled` : `realm ${r.plan.realm}: nothing applied`, ...(waiting.length ? [`${waiting.length} change(s) need ${waiting.some((c) => c.kind === "orphan") ? "--prune --yes" : "--yes"}`] : [])].join("\n"));
      return waiting.length && ctx.flags["yes"] !== true ? 3 : 0;
    },
  },
  "infra:token": {
    usage: "pso infra:token [--env <name>] --user <name> [--scopes a,b] [--ttl 900] [--json]",
    summary: "Get an access token for a development user: signed offline (pso-dev identity) or issued by the environment's Keycloak (password grant through the development-only API client). Development environments only",
    async run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envFlag(ctx), INFRA_HOOKS));
      const user = str(ctx.flags["user"]);
      if (!user) throw new CliError("--user <name> is required");
      if (p.topology.identity?.provider === "pso-dev") {
        const scopes = (str(ctx.flags["scopes"]) ?? p.topology.identity.users.find((u) => u.username === user)?.scopes.join(",") ?? "").split(",").filter(Boolean);
        const ttl = Number(str(ctx.flags["ttl"]) ?? 900);
        if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86_400) throw new CliError("--ttl must be 30 to 86400 seconds");
        const tok = engine(() => mintDevToken(root, p.topology, { sub: user, scopes, ttlSec: ttl }));
        if (json(ctx)) emit(ctx, { accessToken: tok, scopes, expiresIn: ttl }, ""); else ctx.print(tok);
        return 0;
      }
      if (str(ctx.flags["scopes"])) throw new CliError("--scopes applies to the pso-dev identity: Keycloak issues the scopes the user has (pso.infra.json identity.users)");
      const t = await engineAsync(() => developmentUserToken(root, p.topology, user));
      if (json(ctx)) emit(ctx, t, ""); else ctx.print(t.accessToken);
      return 0;
    },
  },
};

/**
 * Called after a command changed what the infrastructure is derived from (a service, a FEI, a MEI registration). Every declared environment
 * is planned; development environments are reconciled at once (only PSO-managed resources, never hand edits or supplied material), other
 * environments get the list of affected resources and the command that applies them.
 */
async function liveIdentity(root: string, t: Topology) {
  try { const r = await applyIdentity(root, t, identityAccess(root, t)); return r; } catch { return undefined; } // not running: the next start imports the realm
}
export async function reconcileAfter(ctx: Ctx, root: string, what: string): Promise<void> {
  if (!hasInfraContract(root) || ctx.flags["dry-run"] === true) return;
  const { contract, issues } = loadContract(root);
  if (issues.some((i) => i.severity === "error")) { ctx.print(`note: the infrastructure was not reconciled: ${INFRA_FILE} is invalid (pso infra:validate)`); return; }
  for (const env of Object.keys(contract.environments)) {
    try {
      const p = plan(root, env, INFRA_HOOKS);
      const pending = p.resources.filter((r) => ["create", "replace", "update"].includes(r.action));
      if (!pending.length) continue;
      // an environment that was never provisioned is entirely "pending": only environments that exist are reported as affected
      if (p.kind !== "development") { if (readState(root).environments[env]?.lastApply) ctx.print(`infrastructure of "${env}" is affected by ${what}: ${pending.map((r) => r.id).join(", ")}   (pso infra:apply --env ${env} --yes)`); continue; }
      const r = apply(root, { env, hooks: INFRA_HOOKS, by: `reconcile: ${what}` });
      const done = r.applied.filter((a) => a.result === "done").map((a) => a.id);
      let restart = r.restart;
      // a running Keycloak is updated through its administration API (routine changes: new clients, roles, mappers); no restart, no console
      if (done.includes("identity:realm") && p.topology.identity?.provider === "keycloak") {
        const live = await liveIdentity(root, p.topology);
        if (live) { ctx.print(`  identity provider updated live: ${live.applied.map((c) => `${c.kind} ${c.target}`).join(", ") || "already in sync"}${live.skipped.filter((c) => c.sensitive).length ? ` (${live.skipped.filter((c) => c.sensitive).length} sensitive change(s) wait for: pso infra:identity --env ${env} --apply --yes)` : ""}`); restart = restart.filter((x) => x !== "idp"); }
      }
      ctx.print(`reconciled "${env}" after ${what}: ${done.join(", ")}${restart.length ? `\n  restart if the stack is running: pso docker:restart ${restart.join(" ")} --env ${env}` : ""}`);
    } catch (e) { ctx.print(`note: the infrastructure of "${env}" was not reconciled: ${(e as Error).message}`); }
  }
}

/** How this machine reaches an environment's Keycloak administration API: through the edge with the environment's authority. */
export function identityAccess(root: string, t: Topology): AdminAccess {
  if (!t.identity) throw new InfraError(`environment "${t.env}" has no identity provider`, "PSO_INFRA_IDENTITY_KIND");
  const ca = environmentCa(root, t);
  return { base: new URL(t.identity.issuer).origin, ...(ca ? { ca } : {}), resolve: localResolution(t) };
}
const changeLine = (c: IdentityChange) => `${c.sensitive ? "SENSITIVE " : "          "}${c.kind.padEnd(18)} ${c.target.padEnd(28)} ${c.detail}`;

/** Whether the workspace has adopted the 0.2 infrastructure contract. */
export const hasInfraContract = (root: string): boolean => existsSync(join(root, INFRA_FILE));
export { loadContract, readFileSync };
