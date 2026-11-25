import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadWorkspace, type WorkspaceConfig } from "@pso/core";
import { INFRA_DIR, INFRA_FILE, InfraError, loadContract, pickEnvironment, type ContractIssue, type InfraContract } from "./contract.ts";
import { abs, atomicWrite, cleanTemporaries, clearJournal, exposure, journalBegin, pendingJournal, protectFile, readText, sha256, withLock } from "./fsutil.ts";
import { checkAuthority, checkLeaf, issueAuthority, issueLeaf } from "./pki.ts";
import { MANAGED_MARK, RESERVED_NAMES, paths, renderCompose, renderEdge, renderFeiServer, renderHosts, renderProcessEnv, renderRealm } from "./render.ts";
import { generateSecretValue, localSecretPath, lookupSecret, redact, rememberSecret } from "./secrets.ts";
import { envState, readState, writeState, type InfraState } from "./state.ts";
import { resolveTopology, type FrontendInfo, type Topology } from "./topology.ts";

/**
 * The PSO infrastructure engine.
 *
 *   discover   the workspace, its frontends and pso.infra.json (or the derived default)
 *   graph      every resource the declared environment needs, with its owner and dependencies
 *   inspect    each resource against the disk, read-only: present, valid (chains, keys, names, expiry, permissions), drifted
 *   plan       what applying would do, without doing it
 *   apply      create what is missing and authorized, update what PSO generated and the declarations changed, never touch what an
 *              operator supplies or what somebody edited by hand (drift is reported; `repair` resolves it, with a backup)
 *
 * Apply is idempotent: a valid certificate, key or secret is never regenerated because a command runs again. Every write is atomic, a
 * journal makes an interrupted run visible and recoverable, and one lock keeps two runs apart.
 */

export type ResourceKind = "ca" | "certificate" | "secret" | "signing-key" | "config" | "site" | "ignore-rules";
export type ResourceModule = "certificate-authority" | "tls" | "secrets" | "identity" | "nginx" | "frontends" | "docker" | "hosts" | "environment" | "workspace";
export type Status = "ok" | "missing" | "invalid" | "outdated" | "drifted" | "exposed" | "external-ok" | "external-missing" | "external-unverified" | "blocked";
export type Action = "none" | "create" | "replace" | "update" | "protect" | "repair" | "supply";

export interface ResourceFile { path: string; sensitive: boolean }
export interface Resource {
  id: string;
  kind: ResourceKind;
  module: ResourceModule;
  owner: "pso" | "external";
  description: string;
  dependsOn: string[];
  files: ResourceFile[];
  /** containers that must restart when this resource changes */
  affects: string[];
  render?: () => string;
  cert?: { name: string; names: string[]; client?: boolean; ca: { cert: string; key?: string } };
  secret?: { name: string; generate: boolean };
}
export interface Inspection { status: Status; action: Action; reasons: string[]; warnings: string[]; facts: Record<string, string | number | boolean> }
export interface PlannedResource extends Omit<Resource, "render" | "cert" | "secret">, Inspection {}
export interface Plan { workspace: string; environment: string; kind: Topology["kind"]; declared: boolean; topology: Topology; resources: PlannedResource[]; issues: ContractIssue[]; interrupted: string[]; summary: Record<Status, number> & { changes: number; blocked: number; drift: number } }

export interface InfraModel { root: string; ws: WorkspaceConfig; contract: InfraContract; declared: boolean; issues: ContractIssue[]; frontends: FrontendInfo[]; scopes: string[] }

export interface EngineHooks {
  /** reads the FEIs of the workspace (the CLI passes a reader based on @pso/frontend/node) */
  frontends?: (root: string, ws: WorkspaceConfig) => { frontends: FrontendInfo[]; scopes: string[] };
}

export function loadModel(root: string, hooks: EngineHooks = {}): InfraModel {
  const { config, diagnostics } = loadWorkspace(root);
  if (!config) throw new InfraError(`pso.workspace.json is invalid: ${diagnostics.map((d) => d.message).join("; ")}`, "PSO_INFRA_WORKSPACE");
  const { contract, declared, issues } = loadContract(root);
  const fe = hooks.frontends ? hooks.frontends(root, config) : { frontends: [], scopes: [] };
  for (const s of config.services) if ((RESERVED_NAMES as readonly string[]).includes(s.name) || s.name.endsWith("-db") || s.name.endsWith("-client")) issues.push({ code: "PSO_INFRA_RESERVED_NAME", severity: "error", message: `service name "${s.name}" is reserved by the generated topology (${RESERVED_NAMES.join(", ")}, *-db, *-client)`, path: "pso.workspace.json" });
  return { root, ws: config, contract, declared, issues, frontends: fe.frontends, scopes: fe.scopes };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the resource graph of one environment

export function buildResources(m: InfraModel, t: Topology): Resource[] {
  const e = t.env, out: Resource[] = [];
  const dev = t.kind === "development";
  const pso = t.tlsSource === "pso-dev-ca";
  const ext = (rel: string): string => `${t.decl.tls?.dir?.replace(/\/+$/, "")}/${rel}`;
  const caCert = pso ? `${paths.ca(e)}/ca.crt` : ext("ca.crt");
  const caKey = pso ? `${paths.ca(e)}/ca.key` : undefined;
  out.push({ id: "ca", kind: "ca", module: "certificate-authority", owner: pso ? "pso" : "external", description: pso ? `development certificate authority of "${e}" (exists only on this machine, never trusted by the OS unless you install it)` : `the operator's certificate authority (${caCert})`, dependsOn: [], files: [{ path: caCert, sensitive: false }, ...(caKey ? [{ path: caKey, sensitive: true }] : [])], affects: [] });
  const cert = (name: string, names: string[], description: string, affects: string[], client = false) => {
    const dir = pso ? paths.certs(e, name) : ext(name);
    out.push({ id: `cert:${name}`, kind: "certificate", module: "tls", owner: pso ? "pso" : "external", description, dependsOn: ["ca"], files: [{ path: `${dir}/tls.crt`, sensitive: false }, { path: `${dir}/tls.key`, sensitive: true }, { path: `${dir}/ca.crt`, sensitive: false }], affects, cert: { name, names, ...(client ? { client: true } : {}), ca: { cert: caCert, ...(caKey ? { key: caKey } : {}) } } });
  };
  cert("edge", ["edge", "localhost", ...t.publicHosts], `edge gateway: ${t.publicHosts.join(", ")}`, ["edge"]);
  for (const s of t.services) cert(s.name, [s.name, "localhost"], s.role === "orchestrator" ? `${s.name}: inbound TLS from the edge` : `${s.name}: TLS${s.mtls ? " (mutual: clients must present a certificate)" : ""}`, [s.name], s.mtls);
  if (t.orchestrator && t.services.some((s) => s.mtls)) cert(`${t.orchestrator.name}-client`, [t.orchestrator.name], `${t.orchestrator.name}: client identity for mutual TLS to ${t.services.filter((s) => s.mtls).map((s) => s.name).join(", ")}`, [t.orchestrator.name], true);
  if (t.identity?.provider === "keycloak") cert("idp", ["idp", "localhost", "127.0.0.1", t.identity.host], `identity provider (${t.identity.host})`, ["idp"]);

  // secrets: generated only in development and only for what PSO itself needs or the contract allows to generate
  const secret = (name: string, description: string, generate: boolean, affects: string[]) => {
    const local = t.secretProvider === "local";
    out.push({ id: `secret:${name}`, kind: "secret", module: "secrets", owner: local ? "pso" : "external", description, dependsOn: [], files: local ? [{ path: localSecretPath(e, name), sensitive: true }] : [], affects, secret: { name, generate: local && dev && generate } });
  };
  for (const s of t.services.filter((x) => x.db)) secret(`db-${s.name}`, `password of ${s.name}'s database`, true, [s.name, `${s.name}-db`]);
  if (t.identity?.provider === "keycloak") {
    secret("idp-admin", "identity provider bootstrap administrator password", true, ["idp"]);
    for (const u of t.identity.users) secret(`user-${u.username}`, `password of the development user "${u.username}"`, true, ["idp"]);
    if (dev) secret("idp-api-client", "client secret of the development API client (Studio)", true, ["idp"]);
  }
  for (const [n, s] of Object.entries(m.contract.secrets ?? {})) secret(n, s.description ?? `declared secret "${n}"`, s.generate === "random", Object.entries(m.contract.services ?? {}).filter(([, x]) => x.secrets?.includes(n)).map(([k]) => k));

  if (t.identity?.provider === "keycloak") out.push({ id: "identity:realm", kind: "config", module: "identity", owner: "pso", description: `realm "${t.identity.realm}": roles (scopes), one OIDC client per FEI with its redirect URIs${dev ? ", development users" : ""}`, dependsOn: [], files: [{ path: `${paths.identity(e)}/realm.json`, sensitive: false }], affects: ["idp"], render: () => renderRealm(t) });
  if (t.identity?.provider === "pso-dev") {
    const keyFile = `${paths.identity(e)}/signing-key.pem`;
    out.push({ id: "identity:signing-key", kind: "signing-key", module: "identity", owner: "pso", description: "development token signing key (ES256)", dependsOn: [], files: [{ path: keyFile, sensitive: true }], affects: [] });
    out.push({ id: "identity:jwks", kind: "config", module: "identity", owner: "pso", description: "public key set served by the edge", dependsOn: ["identity:signing-key"], files: [{ path: `${paths.identity(e)}/jwks.json`, sensitive: false }], affects: ["edge"], render: () => renderJwks(readText(abs(m.root, keyFile)) ?? "") });
  }
  out.push({ id: "nginx:edge", kind: "config", module: "nginx", owner: "pso", description: `edge routing: ${t.publicHosts.length} host(s)`, dependsOn: [], files: [{ path: paths.nginx(e, "edge"), sensitive: false }], affects: ["edge"], render: () => renderEdge(t) });
  for (const f of t.frontends) {
    out.push({ id: `site:${f.name}`, kind: "site", module: "frontends", owner: "pso", description: `site root of ${f.name} (releases are published here)`, dependsOn: [], files: [{ path: paths.site(e, f.name), sensitive: false }], affects: [] });
    out.push({ id: `nginx:${f.name}`, kind: "config", module: "nginx", owner: "pso", description: `static server of ${f.name} (base ${f.basePath})`, dependsOn: [], files: [{ path: paths.nginx(e, f.name), sensitive: false }], affects: [f.name], render: () => renderFeiServer(t, f.name) });
    out.push({ id: `runtime-config:${f.name}`, kind: "config", module: "frontends", owner: "pso", description: `runtime configuration of ${f.name}: ${f.auth} sign-in, ${f.info.microfrontends.length} microfrontend(s)`, dependsOn: [`site:${f.name}`], files: [{ path: `${paths.site(e, f.name)}/pso-runtime-config.json`, sensitive: false }], affects: [], render: () => renderRuntimeConfig(t, f.name) });
  }
  out.push({ id: "docker:compose", kind: "config", module: "docker", owner: "pso", description: "container topology (services, networks, volumes, secrets, health checks, limits)", dependsOn: [], files: [{ path: paths.compose(e), sensitive: false }], affects: [], render: () => renderCompose(t, m.contract, "stack") });
  if (dev) {
    if (t.services.some((s) => s.db) || t.identity?.provider === "keycloak") out.push({ id: "docker:compose-deps", kind: "config", module: "docker", owner: "pso", description: "dependencies for local processes (databases, identity provider) on loopback", dependsOn: [], files: [{ path: paths.composeDeps(e), sensitive: false }], affects: [], render: () => renderCompose(t, m.contract, "dependencies") });
    out.push({ id: "hosts", kind: "config", module: "hosts", owner: "pso", description: `proposed hosts entries: ${t.publicHosts.join(" ")}`, dependsOn: [], files: [{ path: paths.hosts(e), sensitive: false }], affects: [], render: () => renderHosts(t, m.ws.name) });
    for (const s of t.services) out.push({ id: `env:${s.name}`, kind: "config", module: "environment", owner: "pso", description: `environment of ${s.name} as a local process`, dependsOn: [], files: [{ path: paths.env(e, s.name), sensitive: false }], affects: [], render: () => renderProcessEnv(t, m.contract, s) });
  }
  out.push({ id: "workspace:ignore", kind: "ignore-rules", module: "workspace", owner: "pso", description: ".infra/ is excluded from version control", dependsOn: [], files: [{ path: ".gitignore", sensitive: false }, { path: `${INFRA_DIR}/.gitignore`, sensitive: false }], affects: [] });
  return out;
}

export function renderRuntimeConfig(t: Topology, fei: string): string {
  const f = t.frontends.find((x) => x.name === fei)!;
  const idp = t.identity;
  const auth = f.auth === "oidc" && idp ? { kind: "oidc", issuer: idp.issuer, authorizationEndpoint: idp.authorizationEndpoint, tokenEndpoint: idp.tokenEndpoint, clientId: f.clientId, scope: "openid", ...(idp.logoutEndpoint ? { logoutEndpoint: idp.logoutEndpoint } : {}), restoreSession: true } : { kind: f.auth === "oidc" ? "none" : f.auth };
  return JSON.stringify({ schema: 1, fei: f.name, mode: "production", orchestrator: { basePath: f.info.orchestratorBasePath, channelsPath: "/channels" }, remotes: Object.fromEntries(f.info.microfrontends.map((n) => [n, { manifest: `/_mei/${n}/active.json` }])), auth }, null, 2) + "\n";
}

export function renderJwks(keyPem: string): string {
  if (!keyPem) return "";
  const jwk = createPublicKey(createPrivateKey(keyPem)).export({ format: "jwk" }) as Record<string, string>;
  const kid = createHash("sha256").update(JSON.stringify({ crv: jwk["crv"], kty: jwk["kty"], x: jwk["x"], y: jwk["y"] })).digest("base64url").slice(0, 16);
  return JSON.stringify({ keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] }, null, 2) + "\n";
}

const order = (rs: Resource[]): Resource[] => {
  const byId = new Map(rs.map((r) => [r.id, r])), seen = new Set<string>(), out: Resource[] = [];
  const visit = (r: Resource) => { if (seen.has(r.id)) return; seen.add(r.id); for (const d of r.dependsOn) { const x = byId.get(d); if (x) visit(x); } out.push(r); };
  rs.forEach(visit);
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// inspection (read-only)

const IGNORE_BLOCK = ["# PSO infrastructure (.infra/): key material, secrets, state and generated configuration are never committed", ".infra/"];
const fileAbs = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : abs(root, p));

export function inspect(m: InfraModel, t: Topology, r: Resource, st: InfraState, upstreamChanges: Set<string>): Inspection {
  const facts: Record<string, string | number | boolean> = {}, reasons: string[] = [], warnings: string[] = [];
  const rec = envState(st, t.env).resources[r.id];
  const res = (status: Status, action: Action): Inspection => ({ status, action, reasons, warnings, facts });
  const authoritiesChanging = r.dependsOn.some((d) => upstreamChanges.has(d));
  const generationAllowed = t.kind === "development";
  switch (r.kind) {
    case "ca": {
      const f = r.files[0]!.path, k = r.files[1]?.path;
      if (r.owner === "external") {
        if (!existsSync(fileAbs(m.root, f))) { reasons.push(`${f} is not on this machine: it is supplied on the deployment host`); return res("external-unverified", "supply"); }
        const c = checkAuthority(fileAbs(m.root, f)); Object.assign(facts, c.facts); reasons.push(...c.problems); warnings.push(...c.warnings);
        return c.ok ? res("external-ok", "none") : res("external-missing", "supply");
      }
      if (!existsSync(fileAbs(m.root, f))) { reasons.push("not created yet"); return res("missing", generationAllowed ? "create" : "supply"); }
      const c = checkAuthority(fileAbs(m.root, f), k ? fileAbs(m.root, k) : undefined); Object.assign(facts, c.facts); warnings.push(...c.warnings);
      if (!c.ok) { reasons.push(...c.problems); return res("invalid", generationAllowed ? "replace" : "supply"); }
      const ex = k ? exposure(fileAbs(m.root, k)) : undefined; if (ex) { reasons.push(`private key ${ex}`); return res("exposed", "protect"); }
      return res("ok", "none");
    }
    case "certificate": {
      const [crt, key, ca] = r.files.map((x) => fileAbs(m.root, x.path)) as [string, string, string];
      if (r.owner === "external") {
        if (!existsSync(crt)) { reasons.push(`${r.files[0]!.path} is not on this machine: it is supplied on the deployment host`); return res("external-unverified", "supply"); }
        const c = checkLeaf(crt, key, fileAbs(m.root, r.cert!.ca.cert), r.cert!.names, { ...(r.cert!.client ? { client: true } : {}) }); Object.assign(facts, c.facts); warnings.push(...c.warnings); reasons.push(...c.problems);
        return c.ok ? res("external-ok", "none") : res("external-missing", "supply");
      }
      if (authoritiesChanging) { reasons.push("its authority is created or replaced in this run"); return res(existsSync(crt) ? "invalid" : "missing", existsSync(crt) ? "replace" : "create"); }
      if (!existsSync(crt)) { reasons.push("not issued yet"); return res("missing", generationAllowed ? "create" : "supply"); }
      const c = checkLeaf(crt, key, fileAbs(m.root, r.cert!.ca.cert), r.cert!.names, { ...(r.cert!.client ? { client: true } : {}) }); Object.assign(facts, c.facts); warnings.push(...c.warnings);
      if (!c.ok) { reasons.push(...c.problems); return res("invalid", generationAllowed ? "replace" : "supply"); }
      if (!existsSync(ca) || readText(ca)!.trim() !== readText(fileAbs(m.root, r.cert!.ca.cert))?.trim()) { reasons.push("the copy of the authority next to the certificate is missing or stale"); return res("outdated", "update"); }
      const ex = exposure(key); if (ex) { reasons.push(`private key ${ex}`); return res("exposed", "protect"); }
      return res("ok", "none");
    }
    case "secret": {
      const s = r.secret!;
      const l = lookupSecret(m.root, t.env, t.secretProvider, s.name, t.decl.secrets?.dir);
      facts["source"] = l.source;
      if (l.value) rememberSecret(l.value);
      if (r.owner === "external") {
        if (l.present) { facts["length"] = l.value!.length; return res("external-ok", "none"); }
        // a variable injected by the platform, or a secret directory that exists on the deployment host only, cannot be verified here
        const remoteDir = t.secretProvider === "file" && !existsSync(t.decl.secrets?.dir ?? "/run/secrets");
        reasons.push(remoteDir ? `${t.decl.secrets?.dir} is not on this machine: the secret is supplied on the deployment host` : `not provided (${l.source})`);
        return res(t.secretProvider === "env" || remoteDir ? "external-unverified" : "external-missing", "supply");
      }
      if (!l.present) { reasons.push("not set"); return res("missing", s.generate ? "create" : "supply"); }
      facts["length"] = l.value!.length;
      const ex = exposure(fileAbs(m.root, r.files[0]!.path)); if (ex) { reasons.push(`file ${ex}`); return res("exposed", "protect"); }
      return res("ok", "none");
    }
    case "signing-key": {
      const f = fileAbs(m.root, r.files[0]!.path);
      const pem = readText(f);
      if (!pem) { reasons.push("not created yet"); return res("missing", generationAllowed ? "create" : "supply"); }
      try { createPrivateKey(pem); } catch { reasons.push("is not a valid private key"); return res("invalid", generationAllowed ? "replace" : "supply"); }
      const ex = exposure(f); if (ex) { reasons.push(`file ${ex}`); return res("exposed", "protect"); }
      return res("ok", "none");
    }
    case "site": return existsSync(fileAbs(m.root, r.files[0]!.path)) ? res("ok", "none") : (reasons.push("directory does not exist"), res("missing", "create"));
    case "ignore-rules": {
      const gi = readText(abs(m.root, ".gitignore")) ?? "";
      const covered = gi.split(/\r?\n/).some((l) => /^\/?\.infra\/?\*{0,2}$/.test(l.trim()));
      const inner = readText(abs(m.root, `${INFRA_DIR}/.gitignore`));
      if (!covered) reasons.push(".gitignore does not exclude .infra/");
      if (inner?.trim() !== "*") reasons.push(".infra/.gitignore is missing");
      return reasons.length ? res(covered ? "outdated" : "missing", "update") : res("ok", "none");
    }
    case "config": {
      const f = fileAbs(m.root, r.files[0]!.path);
      const want = r.render!();
      const have = readText(f);
      facts["sha256"] = sha256(want).slice(0, 12);
      if (have === undefined) { reasons.push("not generated yet"); return res("missing", "create"); }
      if (have === want) return res("ok", "none");
      const recorded = rec?.files[r.files[0]!.path];
      if (recorded && recorded === sha256(have)) { reasons.push("the declarations changed since it was generated"); return res("outdated", "update"); }
      // PSO did not write this content: a hand edit, or a file PSO never owned. Never overwritten implicitly.
      reasons.push(recorded ? "edited by hand since PSO generated it" : "exists but was not generated by PSO (or its state was lost)");
      return res("drifted", "repair");
    }
  }
}

export function plan(root: string, envName: string | undefined, hooks: EngineHooks = {}): Plan {
  const m = loadModel(root, hooks);
  const errors = m.issues.filter((i) => i.severity === "error");
  if (errors.length) throw new InfraError(`${INFRA_FILE} is invalid:\n${errors.map((i) => `  ${i.path}: ${i.message}${i.hint ? ` (${i.hint})` : ""}`).join("\n")}`, errors[0]!.code);
  const { name } = pickEnvironment(m.contract, envName);
  const t = resolveTopology(m.ws, m.contract, name, m.frontends, m.scopes);
  const st = readState(root);
  const changing = new Set<string>();
  const resources: PlannedResource[] = [];
  for (const r of order(buildResources(m, t))) {
    const i = inspect(m, t, r, st, changing);
    if (i.action === "create" || i.action === "replace") changing.add(r.id);
    const { render: _r, cert: _c, secret: _s, ...rest } = r;
    resources.push({ ...rest, ...i, reasons: i.reasons.map(redact), warnings: i.warnings.map(redact) });
  }
  const summary = { ok: 0, missing: 0, invalid: 0, outdated: 0, drifted: 0, exposed: 0, "external-ok": 0, "external-missing": 0, "external-unverified": 0, blocked: 0, changes: 0, drift: 0 } as Plan["summary"];
  for (const r of resources) { summary[r.status]++; if (["create", "replace", "update", "protect"].includes(r.action)) summary.changes++; if (r.action === "supply" && r.status !== "external-unverified") summary.blocked++; if (r.status === "drifted") summary.drift++; }
  return { workspace: m.ws.name, environment: name, kind: t.kind, declared: m.declared, topology: t, resources, issues: m.issues, interrupted: pendingJournal(root).map((j) => j.resource), summary };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// apply

export interface ApplyOptions {
  env?: string;
  /** resolve drift: overwrite managed files that were edited by hand (the edited version is kept in .infra/backups/) */
  repair?: boolean;
  /** limit to these resource ids (dependencies are inspected, not forced) */
  only?: string[];
  /** replace these valid resources anyway (explicit rotation) */
  rotate?: string[];
  by?: string;
  hooks?: EngineHooks;
  dryRun?: boolean;
}
export interface AppliedResource { id: string; action: Action; result: "done" | "skipped" | "refused"; detail: string; files: string[] }
export interface ApplyResult { plan: Plan; applied: AppliedResource[]; restart: string[]; recovered: string[]; notes: string[]; backups: string[] }

export function apply(root: string, o: ApplyOptions = {}): ApplyResult {
  const op = o.repair ? "repair" : "apply";
  return withLock(root, op, (notes) => {
    const interrupted = pendingJournal(root);
    const temporaries = cleanTemporaries(root);
    const recovered = [...new Set([...interrupted.map((j) => j.resource), ...temporaries])];
    if (interrupted.length) notes.push(`an earlier provisioning was interrupted while writing ${[...new Set(interrupted.map((j) => j.resource))].join(", ")}: those resources are checked again and completed`);
    if (temporaries.length) notes.push(`removed ${temporaries.length} partial file(s) left by the interrupted run`);
    const before = plan(root, o.env, o.hooks ?? {});
    const m = loadModel(root, o.hooks ?? {});
    const t = before.topology;
    const st = readState(root);
    const es = envState(st, t.env);
    const tx = `${Date.now().toString(36)}-${process.pid}`;
    const applied: AppliedResource[] = [];
    const restart = new Set<string>();
    const backups: string[] = [];
    const changing = new Set<string>();
    const rotate = new Set(o.rotate ?? []);
    const caPem = (r: Resource) => ({ certPem: readText(fileAbs(root, r.cert!.ca.cert))!, keyPem: readText(fileAbs(root, r.cert!.ca.key!))! });
    const log = (entry: Record<string, unknown>) => { try { const f = abs(root, `${INFRA_DIR}/logs/infra.log`); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, redact(JSON.stringify({ at: new Date().toISOString(), op, env: t.env, ...entry })) + "\n"); } catch { /* the log never fails a provisioning */ } };

    for (const r of order(buildResources(m, t))) {
      if (o.only && !o.only.includes(r.id)) continue;
      let i = inspect(m, t, r, st, changing);
      if (rotate.has(r.id) && (r.kind === "certificate" || r.kind === "ca" || r.kind === "secret" || r.kind === "signing-key") && r.owner === "pso" && i.action === "none") i = { ...i, action: "replace", reasons: ["rotation requested"] };
      if (i.action === "repair" && !o.repair) { applied.push({ id: r.id, action: i.action, result: "skipped", detail: `drift: ${i.reasons.join("; ")} (run pso infra:repair to regenerate it; the edited file is backed up)`, files: r.files.map((f) => f.path) }); continue; }
      if (i.action === "none") continue;
      if (i.action === "supply") { applied.push({ id: r.id, action: i.action, result: "refused", detail: i.reasons.join("; ") || "must be supplied by the operator", files: r.files.map((f) => f.path) }); continue; }
      if (o.dryRun) { applied.push({ id: r.id, action: i.action, result: "skipped", detail: "dry run", files: r.files.map((f) => f.path) }); continue; }
      const done = journalBegin(root, { tx, op, resource: r.id, files: r.files.map((f) => f.path) });
      const wrote: string[] = [];
      const write = (p: string, content: string | Buffer, sensitive: boolean) => { atomicWrite(fileAbs(root, p), content, { sensitive }); wrote.push(p); };
      try {
        switch (r.kind) {
          case "ca": {
            if (i.action === "protect") { for (const f of r.files.filter((x) => x.sensitive)) protectFile(fileAbs(root, f.path)); break; }
            const ca = issueAuthority(`PSO development CA (${m.ws.name}/${t.env}) - not for production`);
            write(r.files[1]!.path, ca.keyPem, true); write(r.files[0]!.path, ca.certPem, false);
            changing.add(r.id);
            break;
          }
          case "certificate": {
            if (i.action === "protect") { protectFile(fileAbs(root, r.files[1]!.path)); break; }
            if (i.action === "update") { write(r.files[2]!.path, readText(fileAbs(root, r.cert!.ca.cert))!, false); break; }
            const leaf = issueLeaf(caPem(r), r.cert!.name, r.cert!.names, { ...(r.cert!.client ? { client: true } : {}) });
            // key first, certificate last: an interruption leaves a mismatching pair, which the next run detects and re-issues
            write(r.files[1]!.path, leaf.keyPem, true); write(r.files[2]!.path, caPem(r).certPem, false); write(r.files[0]!.path, leaf.certPem, false);
            changing.add(r.id);
            break;
          }
          case "secret": {
            if (i.action === "protect") { protectFile(fileAbs(root, r.files[0]!.path)); break; }
            const v = generateSecretValue(); rememberSecret(v);
            write(r.files[0]!.path, v, true);
            break;
          }
          case "signing-key": {
            if (i.action === "protect") { protectFile(fileAbs(root, r.files[0]!.path)); break; }
            const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
            write(r.files[0]!.path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), true);
            changing.add(r.id);
            break;
          }
          case "site": mkdirSync(fileAbs(root, r.files[0]!.path), { recursive: true }); break;
          case "ignore-rules": {
            const gi = abs(root, ".gitignore");
            const cur = readText(gi) ?? "";
            if (!cur.split(/\r?\n/).some((l) => /^\/?\.infra\/?\*{0,2}$/.test(l.trim()))) { writeFileSync(gi, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${IGNORE_BLOCK.join("\n")}\n`); wrote.push(".gitignore"); }
            write(`${INFRA_DIR}/.gitignore`, "*\n", false);
            break;
          }
          case "config": {
            const p = r.files[0]!.path, f = fileAbs(root, p);
            if (i.action === "repair") {
              const b = `${INFRA_DIR}/backups/${tx}/${p.replace(/^\.infra\//, "")}`;
              mkdirSync(dirname(abs(root, b)), { recursive: true }); copyFileSync(f, abs(root, b)); backups.push(b);
            }
            write(p, r.render!(), false);
            break;
          }
        }
        done();
        for (const a of r.affects) restart.add(a);
        const files: Record<string, string> = {};
        for (const f of r.files) { const x = fileAbs(root, f.path); if (existsSync(x) && r.kind !== "site") { try { files[f.path] = sha256(readFileSync(x)); } catch { /* directory */ } } }
        const prev = es.resources[r.id];
        const fresh = inspect(m, t, r, st, new Set());
        es.resources[r.id] = { kind: r.kind, owner: r.owner, files, createdAt: prev?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), facts: fresh.facts, ...(prev?.origin ? { origin: prev.origin } : {}) };
        writeState(root, st);
        applied.push({ id: r.id, action: i.action, result: "done", detail: i.reasons.join("; "), files: wrote });
        log({ resource: r.id, action: i.action, result: "done", files: wrote });
      } catch (e) {
        log({ resource: r.id, action: i.action, result: "failed", error: (e as Error).message });
        throw e instanceof InfraError ? e : new InfraError(`${r.id}: ${(e as Error).message}`, "PSO_INFRA_APPLY_FAILED", "The resources written before this one are recorded; run the command again to continue");
      }
    }
    const changed = applied.filter((a) => a.result === "done").length;
    if (!o.dryRun) { es.lastApply = { at: new Date().toISOString(), by: o.by ?? "pso", changed, pso: "0.2.0" }; writeState(root, st); clearJournal(root); }
    const after = o.dryRun ? before : plan(root, o.env, o.hooks ?? {});
    return { plan: after, applied, restart: [...restart].sort(), recovered, notes, backups };
  });
}

/** Records resources that already exist and are valid as PSO-owned (migration of a 0.1 `tls/` directory): nothing is regenerated. */
export function adopt(root: string, env: string, entries: Array<{ id: string; kind: ResourceKind; files: string[]; origin: string }>): void {
  const st = readState(root);
  const es = envState(st, env);
  for (const e of entries) {
    const files: Record<string, string> = {};
    for (const f of e.files) { const x = abs(root, f); if (existsSync(x)) files[f] = sha256(readFileSync(x)); }
    es.resources[e.id] = { kind: e.kind, owner: "pso", files, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), origin: e.origin };
  }
  writeState(root, st);
}

export { MANAGED_MARK };
