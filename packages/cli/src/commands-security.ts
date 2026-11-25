import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { readAuthenticationMode } from "@pso/security";
import { walkFiles, discover, resolveConfig, envLayer, cmp, type Diagnostic, type WorkspaceConfig } from "@pso/core";
import { CliError } from "./fsx.ts";
import { analyzeOrchestrator, routeRows, serviceReferenceDiagnostics } from "./http-static.ts";
import { springSummary, validateSpring } from "./spring-config.ts";
import { str } from "./args.ts";
import { npmInvocation } from "./proc.ts";
import { describeSources, effectiveProjectEnv, type EffectiveEnv } from "./project-env.ts";
import { IDP_DIR, readIdpConfig } from "./commands-idp.ts";
import { emit, requireWorkspace, type Command, type Ctx } from "./commands.ts";

type Sev = "critical" | "high" | "medium" | "low" | "info";
export interface Finding { id: string; severity: Sev; resource: string; message: string; remediation: string }
const RANK: Record<Sev, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

// ---------- key management ----------
interface KeyRecord { kid: string; alg: "RS256" | "ES256"; createdAt: string; status: "active" | "retiring" | "retired" }
const KEYS_DIR = "keys";

const keysDir = (root: string, ctx: Ctx) => join(root, str(ctx.flags["out"]) ?? KEYS_DIR);
const indexFile = (dir: string) => join(dir, "index.json");
const readIndex = (dir: string): KeyRecord[] => (existsSync(indexFile(dir)) ? (JSON.parse(readFileSync(indexFile(dir), "utf8")) as KeyRecord[]) : []);

function restrictFile(file: string): string {
  if (process.platform === "win32") {
    const user = process.env["USERNAME"] ?? "";
    const r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    return r.status === 0 ? "owner-only ACL applied" : "WARNING: could not restrict ACL; protect this file manually";
  }
  return "mode 0600";
}

function writeJwks(dir: string, idx: KeyRecord[]): void {
  const keys = idx.filter((k) => k.status !== "retired").map((k) => ({ ...createPublicKey(readFileSync(join(dir, `${k.kid}.public.pem`), "utf8")).export({ format: "jwk" }), kid: k.kid, alg: k.alg, use: "sig" }));
  writeFileSync(join(dir, "jwks.json"), JSON.stringify({ keys }, null, 2) + "\n");
  writeFileSync(indexFile(dir), JSON.stringify(idx, null, 2) + "\n");
}

function ensureIgnored(root: string, dirName: string): void {
  const gi = join(root, ".gitignore");
  const line = `${dirName}/*.private.pem`;
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!cur.split(/\r?\n/).includes(line)) appendFileSync(gi, `${cur.endsWith("\n") || cur === "" ? "" : "\n"}${line}\n`);
}

function generate(root: string, dir: string, alg: "RS256" | "ES256", status: KeyRecord["status"]): KeyRecord {
  const kid = `k-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
  const pair = alg === "RS256"
    ? generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } })
    : generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  mkdirSync(dir, { recursive: true });
  const priv = join(dir, `${kid}.private.pem`);
  writeFileSync(priv, pair.privateKey, { mode: 0o600 });
  writeFileSync(join(dir, `${kid}.public.pem`), pair.publicKey);
  ensureIgnored(root, relative(root, dir).split(sep).join("/"));
  return { kid, alg, createdAt: new Date().toISOString(), status };
}

const alg = (ctx: Ctx): "RS256" | "ES256" => {
  const a = str(ctx.flags["alg"]) ?? "ES256";
  if (a !== "RS256" && a !== "ES256") throw new CliError(`Unsupported algorithm "${a}"`, "Use RS256 or ES256");
  return a;
};

// ---------- scanning ----------
const SKIP = new Set(["node_modules", ".git", "target", "dist", ".pso", "build"]);
// links are never followed: a symlink inside the project must not make the secret scan read (or report) files elsewhere
function* files(dir: string): Generator<string> {
  for (const p of walkFiles(dir, { ignore: SKIP }).files) {
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile() && st.size < 1_000_000) yield p;
  }
}
const posix = (root: string, p: string) => relative(root, p).split(sep).join("/");

function ignoredByGit(root: string, rel: string): boolean {
  const gi = join(root, ".gitignore");
  if (!existsSync(gi)) return false;
  return readFileSync(gi, "utf8").split(/\r?\n/).some((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return false;
    const re = new RegExp("^" + t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\/$/, "(/.*)?") + "$");
    return re.test(rel) || re.test(rel.split("/").pop()!) || rel.startsWith(t.replace(/\/$/, "") + "/");
  });
}

/**
 * The environment a security check evaluates: `--env`, else PSO_ENV, else development (what the runtime itself assumes).
 * Each project is evaluated with the sources it runs with in that environment (project-env.ts): for development that includes
 * its .env files, for production only the process environment. The checks that read files (keys, secrets, routes, Spring
 * configuration, every pso.config.<environment>.json that exists) do not depend on the choice.
 */
export const checkEnvironment = (explicit?: string): string => explicit ?? process.env["PSO_ENV"] ?? "development";

/** Where each project's configuration was read from for `environment`: shown by the commands so a result is never mistaken for another environment's. */
export function configurationSources(root: string, ws: WorkspaceConfig, environment: string): Array<{ service: string; sources: string }> {
  return ws.services.map((s) => ({ service: s.name, sources: describeSources(effectiveProjectEnv(root, s, process.env, environment)) }));
}

export function securityCheck(root: string, ws: WorkspaceConfig, environment: string = checkEnvironment()): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const envOf = new Map<string, EffectiveEnv>();
  const effective = (s: { name: string; path: string }): NodeJS.ProcessEnv => {
    let e = envOf.get(s.name);
    if (!e) { e = effectiveProjectEnv(root, s, process.env, environment); envOf.set(s.name, e); }
    return e.env;
  };

  // SEC001/002/003: private keys
  for (const f of files(root)) {
    const rel = posix(root, f);
    if (!/\.(pem|key|json|ya?ml|properties|ts|js|java|env|txt|md)$/i.test(f) && !f.endsWith(".env")) continue;
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    if (/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
      if (ignoredByGit(root, rel)) {
        if (process.platform !== "win32" && (statSync(f).mode & 0o077) !== 0) add({ id: "SEC003", severity: "medium", resource: rel, message: "private key file is readable by group/others", remediation: `chmod 600 ${rel}` });
      } else add({ id: "SEC001", severity: "critical", resource: rel, message: "private key material is stored in a file that is not git-ignored", remediation: "Remove it from the repository history, rotate the key (pso security:rotate) and ignore the keys directory" });
    }
  }

  // SEC010: hard-coded credentials in service config
  for (const s of ws.services) {
    const base = join(root, ...s.path.split("/"));
    for (const f of existsSync(base) ? files(base) : []) {
      if (!/application[^/\\]*\.(ya?ml|properties)$/.test(f)) continue;
      // anchored to a key at the start of a line, so the word inside a placeholder such as ${DB_PASSWORD:} never matches
      const m = /^[ \t]*[\w.-]*(password|secret|api[-_]?key)[\w.-]*[ \t]*[:=][ \t]*(?!\$\{|\s|$)(\S+)/im.exec(readFileSync(f, "utf8"));
      if (m) add({ id: "SEC010", severity: "high", resource: posix(root, f), message: `hard-coded ${m[1]!.toLowerCase()} in service configuration`, remediation: "Use an environment placeholder: ${DB_PASSWORD}" });
    }
  }

  // Orchestrator routes
  const orch = ws.services.find((s) => s.role === "orchestrator");
  if (orch) {
    const dir = join(root, ...orch.path.split("/"));
    const analysis = analyzeOrchestrator(dir);
    const routes = routeRows(dir, analysis);
    // any inconsistency between MODULE.pso.ts, ROUTES.pso.ts and the controllers means the orchestrator refuses to start
    for (const d of [...analysis.diagnostics, ...serviceReferenceDiagnostics(analysis, ws)]) add({ id: "SEC011", severity: "high", resource: `${orch.path}/${d.file ?? ""}`, message: `${d.code}: ${d.message.split("\n")[0]}`, remediation: "Run `pso validate` for the full diagnostic and fix the declaration" });
    for (const r of routes) {
      const res = `${orch.path}/${r.file}`;
      if (r.public && r.method !== "GET") add({ id: "SEC004", severity: "high", resource: res, message: `public ${r.method} route ${r.path} accepts unauthenticated state-changing requests`, remediation: "Add a guard or confirm the route is intentionally public" });
      else if (r.public) add({ id: "SEC004", severity: "info", resource: res, message: `public route ${r.method} ${r.path}`, remediation: "Confirm this route should be unauthenticated" });
    }
    // SEC012: a project jwt guard that is not JwtGuard.create() replaces the framework authentication and must be declared
    const jwtGuardFile = ["ts", "js"].map((e) => join(orchestratorComponentDir(dir, "guards"), `jwt.guard.${e}`)).find((p) => existsSync(p));
    if (jwtGuardFile && !/JwtGuard\s*\.\s*create\s*\(/.test(readFileSync(jwtGuardFile, "utf8"))) {
      const mode = readAuthenticationMode(dir, effective(orch), environment);
      const res = posix(root, jwtGuardFile);
      if (mode.provider !== "custom") add({ id: "SEC012", severity: "high", resource: res, message: "a custom jwt guard replaces the framework authentication but security.authentication.provider is not \"custom\"; the orchestrator will refuse to start", remediation: "Declare security.authentication.provider: custom (and customProvider) in pso.config.json, or use JwtGuard.create()" });
      else add({ id: "SEC012", severity: "info", resource: res, message: `custom authentication is declared (provider ${mode.customProvider ?? "unnamed"}): you own token verification for this orchestrator`, remediation: "Create the guard with CustomGuard.create({ provider, verify }) (required in production) and review its verification" });
    }
    // SEC013: the development issuer of this workspace (pso idp:dev) named by the configuration that is being evaluated for
    // production, or by the production configuration file whatever environment is evaluated
    const devIdp = readIdpConfig(join(root, IDP_DIR));
    if (devIdp) {
      const named = (issuer: unknown, uri: unknown): boolean => issuer === devIdp.issuer || (typeof uri === "string" && uri.startsWith(devIdp.issuer.replace(/\/$/, "") + "/"));
      const prodFile = effectiveConfig(root, ws, orch.name, "production", {});
      const inFile = named(prodFile.get("security.authentication.issuer") ?? prodFile.get("security.jwt.issuer"), prodFile.get("security.authentication.jwks.uri") ?? prodFile.get("security.jwt.jwksUri"));
      const inEnv = environment === "production" && named(effective(orch)["PSO_JWT_ISSUER"], effective(orch)["PSO_JWT_JWKS_URI"]);
      if (inFile || inEnv) add({ id: "SEC013", severity: "critical", resource: inFile ? `${orch.path}/pso.config.production.json` : orch.path, message: `the development identity provider of this workspace (${devIdp.issuer}, pso idp:dev) is configured for production: anyone with the development key can sign tokens`, remediation: "Point PSO_JWT_ISSUER, PSO_JWT_AUDIENCE and PSO_JWT_JWKS_URI (or security.authentication.*) at the real identity provider" });
    }
    if (routes.some((r) => r.guards.includes("jwt"))) {
      const env = environment;
      const penv = effective(orch); // the orchestrator's own sources: its .env files (development) under the process environment
      const cfg = effectiveConfig(root, ws, orch.name, env, penv);
      // the runtime reads security.authentication.* and maps the legacy security.jwt.* keys onto it (security/src/config.ts), so both spellings count
      const has = (...keys: string[]) => keys.some((k) => cfg.has(k));
      const missing: string[] = [];
      if (!has("security.authentication.issuer", "security.jwt.issuer")) missing.push("security.authentication.issuer");
      if (!has("security.authentication.audience", "security.jwt.audience")) missing.push("security.authentication.audience");
      const hasKey = has("security.authentication.jwks.uri", "security.authentication.publicKey.file", "security.jwt.jwksUri", "security.jwt.publicKeyFile");
      const envOk = !!penv["PSO_JWT_ISSUER"] && !!penv["PSO_JWT_AUDIENCE"] && (!!penv["PSO_JWT_JWKS_URI"] || !!penv["PSO_JWT_PUBLIC_KEY_FILE"]);
      if (!envOk && (missing.length || !hasKey)) add({ id: "SEC005", severity: "high", resource: orch.path, message: `jwt guard is used but ${[...missing, ...(hasKey ? [] : ["a key source (security.authentication.jwks.uri or security.authentication.publicKey.file)"])].join(", ")} is not configured for "${env}"; the orchestrator will refuse to start`, remediation: `Declare security.authentication.* in pso.config.json, or set the PSO_JWT_* variables${env === "production" ? " in the production environment (environment files are not read for production)" : ` (for development: in ${orch.path}/.env)`}; the legacy security.jwt.* keys are still read` });
      // the evaluated environment, and the production file whenever it exists: a check of development never hides a production mistake
      const uris = new Set<unknown>([cfg.get("security.authentication.jwks.uri") ?? cfg.get("security.jwt.jwksUri") ?? penv["PSO_JWT_JWKS_URI"]]);
      if (env !== "production") { const prod = effectiveConfig(root, ws, orch.name, "production", {}); uris.add(prod.get("security.authentication.jwks.uri") ?? prod.get("security.jwt.jwksUri")); }
      for (const uri of uris) if (typeof uri === "string" && /^http:\/\//.test(uri) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(uri)) add({ id: "SEC007", severity: "high", resource: orch.path, message: "JWKS is fetched over plain http", remediation: "Use an https JWKS URI" });
    }
  }

  // Spring services: deny by default
  for (const s of ws.services.filter((x) => x.runtime === "spring-boot")) {
    const base = join(root, ...s.path.split("/"));
    const sec = [...(existsSync(base) ? files(base) : [])].filter((f) => f.endsWith(".java") && /SecurityFilterChain/.test(readFileSync(f, "utf8")));
    // the PSO security starter provides a deny-by-default chain (JWT resource server, anyRequest().authenticated()); its YAML is validated instead
    const pom = existsSync(join(base, "pom.xml")) ? readFileSync(join(base, "pom.xml"), "utf8") : "";
    if (/<artifactId>pso-security-spring-boot-starter<\/artifactId>/.test(pom)) {
      const sum = springSummary(root, s);
      if (!sum.security.enabled && !sec.length) add({ id: "SEC006", severity: "critical", resource: s.path, message: "pso.security.enabled is false and the service defines no SecurityFilterChain: nothing is enforced", remediation: "Remove pso.security.enabled: false, or provide your own SecurityFilterChain" });
      for (const f of validateSpring(root, s)) add({ id: f.id, severity: f.severity, resource: f.file ?? s.path, message: f.message, remediation: f.remediation });
      if (!sec.length) continue; // a hand-written chain replaces the starter's: it is analysed below
    }
    if (!sec.length) { add({ id: "SEC006", severity: "high", resource: s.path, message: "no SecurityFilterChain found: Spring Security defaults apply", remediation: "Add a SecurityConfig with anyRequest().authenticated()" }); continue; }
    for (const f of sec) {
      const t = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (!/anyRequest\(\)\s*\.\s*(authenticated|denyAll)\(\)/.test(t)) add({ id: "SEC006", severity: "high", resource: posix(root, f), message: "security chain does not end with anyRequest().authenticated()", remediation: "Deny by default: anyRequest().authenticated()" });
      if (/anyRequest\(\)\s*\.\s*permitAll\(\)/.test(t)) add({ id: "SEC006", severity: "critical", resource: posix(root, f), message: "anyRequest().permitAll() disables authorization for the whole service", remediation: "Remove it; permit only specific health endpoints" });
      const open = [...t.matchAll(/requestMatchers\(([^)]*)\)\s*\.\s*permitAll\(\)/g)].map((m) => m[1]!).filter((a) => !/^\s*("\/actuator\/health(\/\*\*)?"\s*,?\s*)+$/.test(a));
      if (open.length) add({ id: "SEC006", severity: "medium", resource: posix(root, f), message: `public matchers beyond health: ${open.join("; ")}`, remediation: "Confirm every permitAll() route is intentionally public" });
    }
  }

  // Config-level findings (plaintext secrets, wide bind)
  // every environment whose file exists is examined, whatever environment was asked for: a secret written in
  // pso.config.production.json is a finding of a development check too
  const environments = [...new Set([environment, "production", ...ENVIRONMENT_NAMES.filter((e) => ws.services.some((x) => existsSync(join(root, ...x.path.split("/"), `pso.config.${e}.json`))))])];
  const seen = new Set<string>();
  for (const s of [undefined, ...ws.services.map((x) => x.name)]) for (const env of environments) {
    const decl = ws.services.find((x) => x.name === s);
    const r = resolveConfig(layersFor(root, ws, s, env, env === environment && decl ? effective(decl) : env === environment ? process.env : {}));
    const once = (f: Finding): void => { const k = `${f.id}|${f.resource}|${f.message}`; if (!seen.has(k)) { seen.add(k); add(f); } };
    for (const d of r.diagnostics) if (d.code === "PSO_CONFIG_PLAINTEXT_SECRET") once({ id: "SEC008", severity: "high", resource: d.file ?? "config", message: d.message, remediation: d.hint ?? "Use a reference" });
    if (r.values.get("server.host")?.value === "0.0.0.0") once({ id: "SEC009", severity: "medium", resource: s ?? "workspace", message: "server.host binds all interfaces", remediation: "Bind 127.0.0.1 and expose services only through the orchestrator" });
  }

  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || cmp(a.id, b.id) || cmp(a.resource, b.resource));
}

import { readJsonSafe } from "./util-json.ts";
import { orchestratorComponentDir } from "./project-structure.ts";
const ENVIRONMENT_NAMES = ["development", "test", "staging", "production"] as const;
function layersFor(root: string, ws: WorkspaceConfig, service: string | undefined, env: string, variables: NodeJS.ProcessEnv = process.env) {
  const layers: Parameters<typeof resolveConfig>[0] = {};
  if (ws.config) layers.workspace = { source: "pso.workspace.json", values: ws.config };
  const s = ws.services.find((x) => x.name === service);
  if (s) {
    const v = readJsonSafe(join(root, ...s.path.split("/"), "pso.config.json"));
    if (v) layers.service = { source: `${s.path}/pso.config.json`, values: v };
    const e = readJsonSafe(join(root, ...s.path.split("/"), `pso.config.${env}.json`));
    if (e) layers["environment-file"] = { source: `${s.path}/pso.config.${env}.json`, values: e };
  }
  const ev = envLayer(variables);
  if (Object.keys(ev).length) layers["environment-variables"] = { source: "PSO_CFG_*", values: ev };
  return layers;
}
const effectiveConfig = (root: string, ws: WorkspaceConfig, service: string, env: string, variables: NodeJS.ProcessEnv = process.env) =>
  new Map([...resolveConfig(layersFor(root, ws, service, env, variables)).values].map(([k, v]) => [k, v.value]));

/** `--env`, validated: a mistyped environment must never silently become another one. */
export function environmentFlag(ctx: Ctx): string {
  const raw = str(ctx.flags["env"]);
  if (raw !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(raw)) throw new CliError(`Invalid --env "${raw.slice(0, 40)}"`, "Use development, test, staging or production", 2);
  return checkEnvironment(raw);
}

const fmt = (f: Finding) => `${f.severity.toUpperCase().padEnd(8)} ${f.id} ${f.resource}\n         ${f.message}\n         fix: ${f.remediation}`;

export const SECURITY_COMMANDS: Record<string, Command> = {
  "security:keys": {
    usage: "pso security:keys [--generate] [--alg ES256|RS256] [--out keys] [--json]",
    summary: "List signing keys (public data only) or generate the first keypair",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const dir = keysDir(root, ctx);
      let idx = readIndex(dir);
      let note = "";
      if (ctx.flags["generate"] === true) {
        if (idx.some((k) => k.status === "active")) throw new CliError("An active key already exists", "Use `pso security:rotate` to replace it");
        const k = generate(root, dir, alg(ctx), "active");
        idx = [...idx, k];
        writeJwks(dir, idx);
        note = `generated ${k.kid} (${k.alg}); private key: ${relative(root, join(dir, `${k.kid}.private.pem`))} (${restrictFile(join(dir, `${k.kid}.private.pem`))}); public JWKS: ${relative(root, join(dir, "jwks.json"))}`;
      }
      emit(ctx, { keys: idx, note }, [note, ...idx.map((k) => `${k.status.padEnd(9)} ${k.kid}  ${k.alg}  ${k.createdAt}`)].filter(Boolean).join("\n") || "(no keys; run with --generate)");
      return 0;
    },
  },
  "security:rotate": {
    usage: "pso security:rotate [--retire <kid>] [--alg ES256|RS256] [--out keys] [--dry-run] [--json]",
    summary: "Create a new active key; the previous one stays in the JWKS as 'retiring' until retired",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const dir = keysDir(root, ctx);
      const idx = readIndex(dir);
      const dry = ctx.flags["dry-run"] === true;
      const retire = str(ctx.flags["retire"]);
      if (retire) {
        const k = idx.find((x) => x.kid === retire);
        if (!k) throw new CliError(`Unknown key "${retire}"`);
        if (k.status === "active") throw new CliError("Refusing to retire the active key", "Rotate first, then retire the old key");
        if (!dry) { k.status = "retired"; writeJwks(dir, idx); }
        emit(ctx, { dryRun: dry, retired: retire }, `${dry ? "[dry-run] " : ""}retired ${retire}: removed from jwks.json (tokens signed with it stop validating)`);
        return 0;
      }
      const cur = idx.find((k) => k.status === "active");
      const a = str(ctx.flags["alg"]) ? alg(ctx) : (cur?.alg ?? "ES256");
      if (dry) { emit(ctx, { dryRun: true, wouldCreate: a, previous: cur?.kid }, `[dry-run] would create a new ${a} key and demote ${cur?.kid ?? "(none)"} to retiring`); return 0; }
      for (const k of idx) if (k.status === "active") k.status = "retiring";
      const nk = generate(root, dir, a, "active");
      idx.push(nk);
      writeJwks(dir, idx);
      emit(ctx, { active: nk.kid, retiring: idx.filter((k) => k.status === "retiring").map((k) => k.kid) }, `new active key ${nk.kid} (${restrictFile(join(dir, `${nk.kid}.private.pem`))})\nretiring (still in JWKS): ${idx.filter((k) => k.status === "retiring").map((k) => k.kid).join(", ") || "-"}\nafter tokens signed with old keys have expired: pso security:rotate --retire <kid>`);
      return 0;
    },
  },
  "security:policy": {
    usage: "pso security:policy [--json]",
    summary: "Show the effective authorization policy of every route and service",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const orch = config.services.find((s) => s.role === "orchestrator");
      const routes = orch ? routeRows(join(root, ...orch.path.split("/"))).map((r) => ({ method: r.method, path: r.path, module: r.module, service: r.service || r.services.join(","), access: r.public ? "public" : r.guards.length ? "guarded" : "DENIED (misconfigured)", guard: r.guard, guards: r.guards, scopes: r.scopes })) : [];
      const f = securityCheck(root, config).filter((x) => x.id === "SEC006");
      const services = config.services.filter((s) => s.runtime === "spring-boot").map((s) => ({ service: s.name, default: f.some((x) => x.resource.startsWith(s.path) && RANK[x.severity] >= 3) ? "NOT deny-by-default" : "deny by default" }));
      emit(ctx, { defaultPolicy: "deny", routes, services }, ["default: deny", ...routes.map((r) => `${r.method.padEnd(7)} ${r.path.padEnd(24)} ${r.access}${r.guard ? `:${r.guard}` : ""}${r.scopes.length ? ` scopes=[${r.scopes.join(",")}]` : ""}  -> ${r.service || "(orchestrator)"}`), ...services.map((s) => `service ${s.service}: ${s.default}`)].join("\n"));
      return 0;
    },
  },
  "security:check": {
    usage: "pso security:check [--env development|test|staging|production] [--strict] [--json]",
    summary: "Examine real configuration and sources for security problems, for one environment and with the configuration sources the application runs with in it (exit 1 on high/critical; --strict also medium)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const environment = environmentFlag(ctx);
      const findings = securityCheck(root, config, environment);
      const limit = ctx.flags["strict"] === true ? RANK.medium : RANK.high;
      const fail = findings.some((f) => RANK[f.severity] >= limit);
      const sources = configurationSources(root, config, environment);
      emit(ctx, { ok: !fail, environment, sources, findings }, [
        `environment: ${environment}${ctx.flags["env"] === undefined && process.env["PSO_ENV"] === undefined ? " (default; choose another with --env or PSO_ENV)" : ""}`,
        ...sources.map((s) => `  ${s.service}: configuration from ${s.sources}`),
        ...(findings.length ? [findings.map(fmt).join("\n")] : []),
        fail ? "FAILED" : "OK",
        ...(environment === "production" ? [] : [`This result is about "${environment}". It says nothing about production: run \`pso security:check --env production\` where the production variables are set (a pipeline, the platform).`]),
      ].join("\n"));
      return fail ? 1 : 0;
    },
  },
  "security:audit": {
    usage: "pso security:audit [--json]",
    summary: "Audit dependencies: npm audit for Node projects, SNAPSHOT/unpinned scan for Maven projects",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const report: Array<{ service: string; tool: string; status: "ok" | "findings" | "skipped"; detail: string; counts?: Record<string, number> }> = [];
      for (const s of config.services) {
        const dir = join(root, ...s.path.split("/"));
        if (s.runtime === "node") {
          if (!existsSync(join(dir, "package-lock.json"))) { report.push({ service: s.name, tool: "npm audit", status: "skipped", detail: "no package-lock.json (run npm install first)" }); continue; }
          const npm = npmInvocation("npm", ["audit", "--json", "--omit=dev"]);
          const r = spawnSync(npm.command, npm.args, { cwd: dir, encoding: "utf8", timeout: 120_000 });
          try {
            const j = JSON.parse(r.stdout) as { metadata?: { vulnerabilities?: Record<string, number> }; error?: unknown };
            const v = j.metadata?.vulnerabilities;
            if (!v) { report.push({ service: s.name, tool: "npm audit", status: "skipped", detail: "audit unavailable (offline or registry error)" }); continue; }
            const bad = (v["critical"] ?? 0) + (v["high"] ?? 0) + (v["moderate"] ?? 0) + (v["low"] ?? 0);
            report.push({ service: s.name, tool: "npm audit", status: bad ? "findings" : "ok", detail: bad ? `${bad} vulnerable package(s)` : "no known vulnerabilities", counts: v });
          } catch { report.push({ service: s.name, tool: "npm audit", status: "skipped", detail: "audit output could not be parsed" }); }
        } else {
          const pom = join(dir, "pom.xml");
          if (!existsSync(pom)) { report.push({ service: s.name, tool: "pom scan", status: "skipped", detail: "no pom.xml" }); continue; }
          const t = readFileSync(pom, "utf8");
          const snaps = [...t.matchAll(/<version>([^<]*SNAPSHOT)<\/version>/g)].length;
          const ranges = [...t.matchAll(/<version>([\[(][^<]*)<\/version>/g)].length;
          report.push({ service: s.name, tool: "pom scan", status: snaps + ranges ? "findings" : "ok", detail: snaps + ranges ? `${snaps} SNAPSHOT and ${ranges} version-range dependencies (not reproducible for production)` : "no SNAPSHOT or ranged versions; CVE scanning of Maven dependencies is NOT performed by this command" });
        }
      }
      const bad = report.some((r) => r.status === "findings");
      emit(ctx, { ok: !bad, report }, report.map((r) => `${r.status.toUpperCase().padEnd(8)} ${r.service.padEnd(16)} ${r.tool}: ${r.detail}`).join("\n"));
      return bad ? 1 : 0;
    },
  },
};

export type { Diagnostic };
