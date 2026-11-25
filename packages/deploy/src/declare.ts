import { looksSecret } from "./redact.ts";
import { canonical, sha256 } from "./crypto.ts";

// same grammar as @pso/frontend (nginx.ts): kept local so the declaration module stays dependency-free
const ROUTE_PATTERN = /^\/(?:(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*(?:\/\*)?)?$/;

/**
 * Deployment and pipeline declarations (DEPLOYMENT.pso.ts, PIPELINE.pso.ts).
 *
 * `defineDeployment` / `definePipeline` give the editor and `tsc` the types. The CLI and Studio never EXECUTE these files to read them:
 * `loadDeclarationFile` parses the TypeScript and evaluates only literal data (objects, arrays, strings, numbers, booleans, null). A
 * declaration that computes something (a function call, a variable, `process.env`) is reported as an error, because importing
 * project code would run it before trust exists. Declarations never hold credentials, only references to them.
 */
export type StrategyType = "blue-green" | "rolling" | "recreate" | "static";
export type StageType = "integrity" | "compatibility" | "security" | "tests" | "resources" | "build" | "health" | "deploy" | "custom";

export interface GitSource { provider: "git"; url: string; branch?: string; tag?: string; commit?: string; /** name of a deploy key or token held in the target's secret store */ credentials?: string; submodules?: boolean }
export interface ArtifactSource { provider: "artifact"; path: string; sha256?: string }
export type SourceDecl = GitSource | ArtifactSource;

/**
 * A static frontend resource (a FEI or a MEI of the frontend ecosystem). It is deployed with the same plan, artifact, signature, lock,
 * history, activation and rollback as any service, but nothing is started: the build output is published into a SITE ROOT that nginx
 * serves, using the release primitives of `@pso/frontend/release` (the same code `pso frontend:publish` runs).
 */
export interface StaticDecl {
  /** the site root this resource publishes into: one per domain, shared by the FEI and its MEIs (`<agent home>/sites/<site>`) */
  site: string;
  kind: "fei" | "mei";
  /** directory of the build output inside the release (default: the service's `dir`, i.e. the artifact root) */
  publish?: string;
  /** FEI: the base path the shell was built for (`/` or `/commerce/`) */
  basePath?: string;
  /** FEI: the orchestrator reached under one same-origin prefix, through the loopback port that always reaches its active release */
  api?: { path?: string; upstreamPort: number; channelsPath?: string };
  /** FEI: client routes whose last segment may look like a file (`/catalog/products/:id`); they are served the entry page before the file rules */
  routes?: string[];
  /** FEI: origins the browser may call besides the site itself (`connect-src`): the identity provider's token endpoint (https; http only for localhost) */
  connectSrc?: string[];
  /**
   * FEI: the runtime configuration the shell loads at start, written on the site by the engine when the shell is activated (and again on rollback):
   * where the orchestrator is (same-origin path), how users sign in, and which release signers are trusted. It holds no secret: a public provider description and public keys.
   */
  runtimeConfig?: { orchestratorBasePath: string; channelsPath?: string; auth: { kind: "none" } | { kind: "dev-token" } | { kind: "oidc"; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; scope?: string; redirectPath?: string; logoutEndpoint?: string; postLogoutRedirectPath?: string; restoreSession?: boolean }; requireSignature?: boolean; trustedKeys?: Array<{ keyId: string; publicKey: string }> };
  /** published versions kept on the site (at least 2: the active one and the one it replaced always stay) */
  retain?: number;
  /** where to probe the active release through nginx (default for a FEI: its own nginx listener) */
  probe?: { port?: number; host?: string };
}

export interface ServiceDecl {
  name: string;
  runtime: "node" | "java" | "command" | "static";
  /** static frontend resources only */
  static?: StaticDecl;
  /** directory of the service inside the source (monorepos) */
  dir?: string;
  /** argv arrays, never shell strings; `{port}` and `{release}` are substituted */
  build?: string[][];
  /** test steps run by the optional tests stage (argv arrays) */
  test?: string[][];
  start?: string[];
  port?: number | "auto";
  portEnv?: string;
  health?: { path?: string; readyPath?: string; expectStatus?: number; timeoutSeconds?: number; intervalSeconds?: number; consecutive?: number };
  env?: Record<string, string>;
  /** ENV_NAME -> name of a secret held by the target environment (never the value) */
  secrets?: Record<string, string>;
  /** seconds the service gets to stop after SIGTERM; it must match the application's own shutdown time */
  shutdownGraceSeconds?: number;
  instances?: number;
  resources?: { memoryMb?: number; diskMb?: number; cpus?: number };
  requires?: { node?: string; java?: string };
  route?: { path?: string };
  /** a fixed loopback port that always reaches the ACTIVE release of this service (through nginx). Other deployments of the same server use it to find this service while releases are swapped behind it */
  internalPort?: number;
  dependsOn?: string[];
  /** contract version this service speaks; checked against its dependents before activation */
  contract?: string;
  consumes?: Record<string, string>;
  /**
   * What this service does that matters while an OLD and a NEW release run side by side (blue-green and rolling always overlap them).
   * PSO cannot see inside the application, so the project says it; the plan refuses overlap strategies that would be unsafe for what it says.
   */
  workload?: {
    /** "singleton": scheduled jobs with no leader election (every instance runs them); "leader-elected": only one instance runs them */
    scheduledJobs?: "none" | "leader-elected" | "singleton";
    /** the application applies its own database migrations when it starts (for example Flyway in Spring Boot) */
    selfMigrates?: boolean;
    /** message consumers of this service. Delivery stays at-least-once: PSO never promises exactly-once */
    consumers?: Array<"dispatch" | "kafka" | "rabbitmq" | "redis">;
    /** consumption order matters (a single active consumer is required) */
    orderedConsumption?: boolean;
    /** the service holds WebSocket / channel connections */
    channels?: boolean;
    /** the service publishes through a transactional outbox relay */
    outbox?: boolean;
  };
}
export interface StrategyDecl { type: StrategyType; proxy?: "nginx" | "none"; rollback?: boolean; autoRollback?: boolean; drainSeconds?: number; retention?: { keep?: number }; downtimeAcknowledged?: boolean }
export interface NginxDecl {
  /** HOST: this application's server includes an attach directory, so a static frontend can serve its locations from the SAME server (one address and certificate). Only PSO-managed files in that directory are loaded */
  attachPoint?: boolean;
  /** STATIC SHELL: do not create a server; add this shell's locations to the server of the named application (which declares `attachPoint`) */
  attachTo?: string;
  domains?: string[]; layout?: "sites" | "conf.d" | string; listen?: { http?: number; https?: number }; tls?: { certificate: string; key: string }; websocket?: boolean; reload?: "sudo" | "direct" }
export interface MigrationDecl { mode: "none" | "expand-contract"; owner?: string; command?: string[]; destructive?: boolean; approvedDestructive?: boolean }
export interface DeploymentDecl {
  name: string;
  environment: string;
  connection: { provider: "ssh"; credentials: string };
  source: SourceDecl;
  services?: ServiceDecl[];
  service?: ServiceDecl;
  strategy: StrategyDecl;
  proxy?: { nginx?: NginxDecl };
  pipeline?: string;
  migrations?: MigrationDecl;
  /** how the services are kept running on the server. The server's policy decides what is allowed; this only REQUESTS one */
  runtime?: { supervisor?: "process" | "systemd"; restart?: "no" | "on-failure" };
  ports?: { from: number; to: number };
  infrastructure?: { requires?: Array<"postgres" | "redis" | "rabbitmq" | "kafka" | "storage"> };
}
export interface StageDecl {
  type: StageType;
  enabled?: boolean;
  id?: string;
  dependsOn?: string[];
  timeoutSeconds?: number;
  onFailure?: "fail" | "continue";
  when?: { environments?: string[] };
  requiresApproval?: boolean;
  /** custom stages only: an argv array run by the target's agent without a shell, as the agent's unprivileged user */
  command?: string[];
}
export interface PipelineDecl { name: string; stages: StageDecl[] }

export const defineDeployment = <T extends DeploymentDecl>(d: T): T => d;
export const definePipeline = <T extends PipelineDecl>(p: T): T => p;

export interface DeclDiagnostic { level: "error" | "warning"; code: string; path: string; message: string }
export const err = (code: string, path: string, message: string): DeclDiagnostic => ({ level: "error", code, path, message });
export const warn = (code: string, path: string, message: string): DeclDiagnostic => ({ level: "warning", code, path, message });

// ------------------------------------------------------------------ validation
const KEBAB = /^[a-z][a-z0-9-]{0,62}$/;
const SECRET_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|private[-_]?key)$/i;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);
export const ENV_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const KNOWN_ENVS = ["local", "development", "testing", "staging", "production"];

/** Rejects credentials written into a declaration: a value that looks like a secret, or a secret-named key holding a literal. */
function scanSecrets(v: unknown, path: string, out: DeclDiagnostic[]): void {
  if (typeof v === "string") { if (looksSecret(v)) out.push(err("PSO-DEC-SECRET", path, "this value looks like a credential; declarations hold references only (store the value with `pso environment:secret` and name it)")); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => scanSecrets(x, `${path}[${i}]`, out)); return; }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k === "secrets") {
      if (isObj(x)) for (const [sk, sv] of Object.entries(x)) if (typeof sv !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(sv)) out.push(err("PSO-DEC-SECRET", `${path}.secrets.${sk}`, "a secret reference is a plain name (letters, digits . _ -)"));
      continue;
    }
    if (k === "credentials") continue; // a reference name; checked by shape elsewhere
    if (SECRET_KEY.test(k) && typeof x === "string") out.push(err("PSO-DEC-SECRET", `${path}.${k}`, `\`${k}\` holds a literal: declarations hold references only`));
    scanSecrets(x, `${path}.${k}`, out);
  }
}

const SITE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
function validateStatic(sv: ServiceDecl, p: string, out: DeclDiagnostic[]): void {
  const s = sv.static as unknown;
  if (!isObj(s)) { out.push(err("PSO-DEC-STATIC", `${p}.static`, 'a service with runtime "static" declares `static: { site, kind }`')); return; }
  const st = s as unknown as StaticDecl;
  if (typeof st.site !== "string" || !SITE_NAME.test(st.site)) out.push(err("PSO-DEC-STATIC", `${p}.static.site`, "site is a kebab-case name (the site root shared by the shell and its microfrontends)"));
  if (st.kind !== "fei" && st.kind !== "mei") out.push(err("PSO-DEC-STATIC", `${p}.static.kind`, 'kind is "fei" (the application shell) or "mei" (a microfrontend)'));
  if (st.publish !== undefined && (typeof st.publish !== "string" || st.publish.startsWith("/") || st.publish.split("/").includes(".."))) out.push(err("PSO-DEC-PATH", `${p}.static.publish`, "publish is relative to the release and stays inside it"));
  if (st.kind === "mei" && (st.basePath !== undefined || st.api !== undefined)) out.push(err("PSO-DEC-STATIC", `${p}.static`, "basePath and api belong to the shell: a microfrontend is served through the shell's configuration"));
  if (st.basePath !== undefined && !/^\/([A-Za-z0-9._~-]+\/)*$/.test(st.basePath)) out.push(err("PSO-DEC-STATIC", `${p}.static.basePath`, 'basePath is absolute and ends with "/" (for example "/" or "/commerce/")'));
  if (st.api !== undefined) {
    if (!isObj(st.api) || !Number.isInteger(st.api.upstreamPort) || st.api.upstreamPort < 1024 || st.api.upstreamPort > 65535) out.push(err("PSO-DEC-STATIC", `${p}.static.api.upstreamPort`, "upstreamPort is the loopback port (1024-65535) that always reaches the orchestrator's active release (its `internalPort`)"));
    else if (st.api.path !== undefined && !/^\/[A-Za-z0-9._~-]+$/.test(st.api.path)) out.push(err("PSO-DEC-STATIC", `${p}.static.api.path`, 'api.path is one plain segment such as "/api"'));
  }
  if (st.routes !== undefined && (st.kind !== "fei" || !Array.isArray(st.routes) || st.routes.length > 200 || !st.routes.every((r) => typeof r === "string" && ROUTE_PATTERN.test(r) && !r.split("/").includes("..")))) out.push(err("PSO-DEC-STATIC", `${p}.static.routes`, 'routes belong to the shell: absolute paths of plain segments, ":param" segments and an optional trailing "/*"'));
  if (st.connectSrc !== undefined && (st.kind !== "fei" || !Array.isArray(st.connectSrc) || st.connectSrc.length > 10 || !st.connectSrc.every((c) => typeof c === "string" && /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/.test(c)))) out.push(err("PSO-DEC-STATIC", `${p}.static.connectSrc`, "connectSrc belongs to the shell: origins such as https://idp.example.com (http only for localhost)"));
  if (st.runtimeConfig !== undefined) {
    const rc = st.runtimeConfig as unknown;
    if (st.kind !== "fei" || !isObj(rc)) out.push(err("PSO-DEC-STATIC", `${p}.static.runtimeConfig`, "runtimeConfig belongs to the shell and is an object"));
    else {
      const o = rc as Record<string, unknown>; const au = o["auth"];
      if (typeof o["orchestratorBasePath"] !== "string" || !/^(\/([A-Za-z0-9._~-]+\/?)*)?$/.test(o["orchestratorBasePath"])) out.push(err("PSO-DEC-STATIC", `${p}.static.runtimeConfig.orchestratorBasePath`, 'a same-origin path such as "/api" (or "" for the root)'));
      if (o["channelsPath"] !== undefined && (typeof o["channelsPath"] !== "string" || !/^\/[A-Za-z0-9._~/-]*$/.test(o["channelsPath"]))) out.push(err("PSO-DEC-STATIC", `${p}.static.runtimeConfig.channelsPath`, "a same-origin path"));
      if (!isObj(au) || !(["none", "dev-token", "oidc"] as unknown[]).includes(au["kind"])) out.push(err("PSO-DEC-STATIC", `${p}.static.runtimeConfig.auth`, 'auth.kind is "none", "dev-token" or "oidc"'));
      else if (au["kind"] === "oidc") for (const k of ["issuer", "authorizationEndpoint", "tokenEndpoint", "clientId"]) if (typeof au[k] !== "string" || !au[k]) out.push(err("PSO-DEC-STATIC", `${p}.static.runtimeConfig.auth.${k}`, "required for oidc"));
      const keys = o["trustedKeys"]; if (keys !== undefined && (!Array.isArray(keys) || !keys.every((k) => isObj(k) && typeof k["keyId"] === "string" && typeof k["publicKey"] === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(k["publicKey"])))) out.push(err("PSO-DEC-STATIC", `${p}.static.runtimeConfig.trustedKeys`, "a list of { keyId, publicKey } with the raw ed25519 public key in base64url"));
    }
  }
  if (st.retain !== undefined && !(Number.isInteger(st.retain) && st.retain >= 2 && st.retain <= 100)) out.push(err("PSO-DEC-STATIC", `${p}.static.retain`, "retain is 2 to 100 (the active version and the one it replaced always stay)"));
  if (st.probe !== undefined && (!isObj(st.probe) || (st.probe.port !== undefined && !(Number.isInteger(st.probe.port) && st.probe.port >= 1 && st.probe.port <= 65535)))) out.push(err("PSO-DEC-STATIC", `${p}.static.probe`, "probe.port is 1-65535"));
  for (const k of ["port", "instances", "internalPort", "route", "health", "start", "workload"] as const) if ((sv as unknown as Record<string, unknown>)[k] !== undefined) out.push(err("PSO-DEC-STATIC", `${p}.${k}`, `a static resource runs no process: ${k} does not apply`));
}

export function servicesOf(d: DeploymentDecl): ServiceDecl[] { return d.services ?? (d.service ? [d.service] : []); }

export function validateDeployment(raw: unknown): DeclDiagnostic[] {
  const out: DeclDiagnostic[] = [];
  if (!isObj(raw)) return [err("PSO-DEC-SHAPE", "$", "a deployment declaration is an object")];
  const d = raw as unknown as DeploymentDecl;
  scanSecrets(raw, "$", out);
  if (typeof d.name !== "string" || !KEBAB.test(d.name)) out.push(err("PSO-DEC-NAME", "$.name", "name is kebab-case, up to 63 characters"));
  if (typeof d.environment !== "string" || !ENV_NAME.test(d.environment)) out.push(err("PSO-DEC-ENV", "$.environment", "environment is a lower-case name such as local, development, testing, staging, production or a custom one"));
  else if (!KNOWN_ENVS.includes(d.environment)) out.push(warn("PSO-DEC-ENV-CUSTOM", "$.environment", `custom environment "${d.environment}": it gets no built-in policy defaults`));
  if (!isObj(d.connection) || d.connection.provider !== "ssh") out.push(err("PSO-DEC-CONN", "$.connection.provider", 'the only implemented connection provider is "ssh"'));
  else if (typeof d.connection.credentials !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(d.connection.credentials)) out.push(err("PSO-DEC-CONN", "$.connection.credentials", "name a registered connection (kebab-case; see `pso connection:add`)"));
  const s = d.source as unknown;
  if (!isObj(s)) out.push(err("PSO-DEC-SOURCE", "$.source", "source is required"));
  else if (s["provider"] === "git") {
    if (typeof s["url"] !== "string" || !/^(https:\/\/|ssh:\/\/|git@|file:\/\/\/)/.test(s["url"])) out.push(err("PSO-DEC-SOURCE", "$.source.url", "git url must be https://, ssh://, git@host:path or file:///"));
    else if (/^[a-z]+:\/\/[^/@]*@/i.test(s["url"]) && !/^ssh:\/\/git@/.test(s["url"])) out.push(err("PSO-DEC-SECRET", "$.source.url", "credentials must not be embedded in the repository URL; use `credentials: <name of a secret>`"));
    const refs = ["branch", "tag", "commit"].filter((k) => s[k] !== undefined);
    if (refs.length !== 1) out.push(err("PSO-DEC-SOURCE", "$.source", "give exactly one of branch, tag or commit"));
    if (s["commit"] !== undefined && !/^[0-9a-f]{40}$/.test(String(s["commit"]))) out.push(err("PSO-DEC-SOURCE", "$.source.commit", "an immutable commit reference is the full 40-character SHA-1"));
    for (const k of ["branch", "tag"]) if (s[k] !== undefined && !/^[A-Za-z0-9._\/-]{1,200}$/.test(String(s[k]))) out.push(err("PSO-DEC-SOURCE", `$.source.${k}`, "invalid ref name"));
  } else if (s["provider"] === "artifact") {
    if (typeof s["path"] !== "string" || !s["path"]) out.push(err("PSO-DEC-SOURCE", "$.source.path", "artifact path is required"));
    if (s["sha256"] !== undefined && !/^[0-9a-f]{64}$/.test(String(s["sha256"]))) out.push(err("PSO-DEC-SOURCE", "$.source.sha256", "sha256 is 64 hex characters"));
  } else out.push(err("PSO-DEC-SOURCE", "$.source.provider", 'source.provider is "git" or "artifact"'));

  const services = servicesOf(d);
  if (d.services !== undefined && d.service !== undefined) out.push(err("PSO-DEC-SERVICES", "$", "use `service` or `services`, not both"));
  if (services.length === 0) out.push(err("PSO-DEC-SERVICES", "$.services", "declare at least one service"));
  const names = new Set<string>();
  services.forEach((sv, i) => {
    const p = `$.services[${i}]`;
    if (!isObj(sv)) { out.push(err("PSO-DEC-SERVICES", p, "a service is an object")); return; }
    if (typeof sv.name !== "string" || !KEBAB.test(sv.name)) out.push(err("PSO-DEC-NAME", `${p}.name`, "service name is kebab-case"));
    else if (names.has(sv.name)) out.push(err("PSO-DEC-NAME", `${p}.name`, `duplicate service "${sv.name}"`)); else names.add(sv.name);
    if (!["node", "java", "command", "static"].includes(sv.runtime)) out.push(err("PSO-DEC-RUNTIME", `${p}.runtime`, 'runtime is "node", "java", "command" or "static"'));
    if (sv.runtime === "static") validateStatic(sv, p, out);
    else {
      if (sv.static !== undefined) out.push(err("PSO-DEC-STATIC", `${p}.static`, 'only a service with runtime "static" has a static block'));
      if (!isArgv(sv.start)) out.push(err("PSO-DEC-ARGV", `${p}.start`, 'start is an argv array, e.g. ["node", "dist/main.js"] (no shell strings)'));
    }
    for (const [j, b] of (sv.test ?? []).entries()) if (!isArgv(b)) out.push(err("PSO-DEC-ARGV", `${p}.test[${j}]`, "each test step is an argv array"));
    for (const [j, b] of (sv.build ?? []).entries()) if (!isArgv(b)) out.push(err("PSO-DEC-ARGV", `${p}.build[${j}]`, "each build step is an argv array"));
    if (sv.dir !== undefined && (typeof sv.dir !== "string" || sv.dir.startsWith("/") || sv.dir.split("/").includes(".."))) out.push(err("PSO-DEC-PATH", `${p}.dir`, "dir is relative to the source root and stays inside it"));
    if (sv.route?.path !== undefined && (typeof sv.route.path !== "string" || !/^\/[A-Za-z0-9_\/.~-]{0,200}$/.test(sv.route.path) || sv.route.path.includes(".."))) out.push(err("PSO-DEC-ROUTE", `${p}.route.path`, 'route.path is a URL path of plain characters (letters, digits _ . ~ - /), starting with "/", without ".."; it is written into an nginx location'));
    if (sv.port !== undefined && sv.port !== "auto" && !(Number.isInteger(sv.port) && sv.port >= 1024 && sv.port <= 65535)) out.push(err("PSO-DEC-PORT", `${p}.port`, 'port is "auto" or 1024-65535'));
    if (sv.internalPort !== undefined && !(Number.isInteger(sv.internalPort) && sv.internalPort >= 1024 && sv.internalPort <= 65535)) out.push(err("PSO-DEC-PORT", `${p}.internalPort`, "internalPort is 1024-65535"));
    if (sv.shutdownGraceSeconds !== undefined && !(sv.shutdownGraceSeconds >= 1 && sv.shutdownGraceSeconds <= 600)) out.push(err("PSO-DEC-GRACE", `${p}.shutdownGraceSeconds`, "1 to 600 seconds"));
    if (sv.shutdownGraceSeconds === undefined) out.push(warn("PSO-DEC-GRACE-DEFAULT", `${p}.shutdownGraceSeconds`, "not set: the default of 30 seconds is used; set it to the application's real shutdown time"));
    if (sv.env) for (const [k, v] of Object.entries(sv.env)) { if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) out.push(err("PSO-DEC-ENVVAR", `${p}.env.${k}`, "environment variable names are UPPER_SNAKE_CASE")); if (typeof v !== "string") out.push(err("PSO-DEC-ENVVAR", `${p}.env.${k}`, "values are strings")); }
    if (sv.workload !== undefined) {
      const w = sv.workload as unknown as Record<string, unknown>;
      if (!isObj(w)) out.push(err("PSO-DEC-WORKLOAD", `${p}.workload`, "workload is an object"));
      else {
        for (const k of Object.keys(w)) if (!["scheduledJobs", "selfMigrates", "consumers", "orderedConsumption", "channels", "outbox"].includes(k)) out.push(err("PSO-DEC-WORKLOAD", `${p}.workload.${k}`, "unknown workload field"));
        if (w["scheduledJobs"] !== undefined && !["none", "leader-elected", "singleton"].includes(String(w["scheduledJobs"]))) out.push(err("PSO-DEC-WORKLOAD", `${p}.workload.scheduledJobs`, 'scheduledJobs is "none", "leader-elected" or "singleton"'));
        if (w["consumers"] !== undefined && !(Array.isArray(w["consumers"]) && (w["consumers"] as unknown[]).every((c) => ["dispatch", "kafka", "rabbitmq", "redis"].includes(String(c))))) out.push(err("PSO-DEC-WORKLOAD", `${p}.workload.consumers`, "consumers lists dispatch, kafka, rabbitmq and/or redis"));
        for (const b of ["selfMigrates", "orderedConsumption", "channels", "outbox"]) if (w[b] !== undefined && typeof w[b] !== "boolean") out.push(err("PSO-DEC-WORKLOAD", `${p}.workload.${b}`, `${b} is true or false`));
      }
    }
    for (const dep of sv.dependsOn ?? []) if (!services.some((x) => x?.name === dep)) out.push(err("PSO-DEC-DEPENDS", `${p}.dependsOn`, `unknown service "${dep}"`));
  });
  const st = d.strategy as unknown;
  if (!isObj(st) || !["blue-green", "rolling", "recreate", "static"].includes(String(st["type"]))) out.push(err("PSO-DEC-STRATEGY", "$.strategy.type", 'strategy.type is "blue-green", "rolling", "recreate" or "static"'));
  else if (st["type"] === "static") {
    // a static deployment publishes files; nothing runs, so nothing is started, drained or overlapped
    if (services.length !== 1 || services[0]?.runtime !== "static") out.push(err("PSO-DEC-STRATEGY", "$.strategy.type", 'strategy "static" deploys exactly one service and it must have runtime "static" (a frontend and a backend are separate deployments)'));
    const kind = services[0]?.static?.kind;
    if (kind === "mei" && st["proxy"] === "nginx") out.push(err("PSO-DEC-STRATEGY", "$.strategy.proxy", 'a microfrontend never changes nginx: its releases are served through the shell\'s configuration. Use proxy: "none"'));
    if (kind === "fei" && st["proxy"] !== "nginx") out.push(warn("PSO-DEC-STRATEGY-PROXY", "$.strategy.proxy", 'a shell without proxy: "nginx" is published to the site root but nothing serves it; PSO will not manage the web server'));
  } else {
    if (services.some((x) => x?.runtime === "static")) out.push(err("PSO-DEC-STRATEGY", "$.strategy.type", 'a "static" service needs strategy.type "static"'));
    const proxy = st["proxy"] ?? "none";
    if (st["type"] === "blue-green" && proxy !== "nginx") out.push(err("PSO-DEC-STRATEGY", "$.strategy.proxy", 'blue-green needs a reverse proxy to switch traffic: set proxy: "nginx". PSO never downgrades it to recreate silently'));
    if (st["type"] === "rolling" && services.some((x) => (x?.instances ?? 1) < 2)) out.push(err("PSO-DEC-STRATEGY", "$.strategy.type", "rolling needs at least 2 instances of every service (a single instance cannot stay available while it is replaced); use blue-green or recreate"));
    if (st["type"] === "rolling" && proxy !== "nginx") out.push(err("PSO-DEC-STRATEGY", "$.strategy.proxy", 'rolling needs a reverse proxy that balances instances: proxy: "nginx"'));
    if (st["type"] === "recreate" && st["downtimeAcknowledged"] !== true) out.push(err("PSO-DEC-STRATEGY", "$.strategy.downtimeAcknowledged", "recreate stops the running release before starting the new one: set downtimeAcknowledged: true to confirm the downtime is expected"));
  }
  if (d.runtime !== undefined) {
    if (!isObj(d.runtime)) out.push(err("PSO-DEC-RUNTIME", "$.runtime", "runtime is an object"));
    else {
      if (d.runtime.supervisor !== undefined && d.runtime.supervisor !== "process" && d.runtime.supervisor !== "systemd") out.push(err("PSO-DEC-RUNTIME", "$.runtime.supervisor", 'supervisor is "process" or "systemd"'));
      if (d.runtime.restart !== undefined && d.runtime.restart !== "no" && d.runtime.restart !== "on-failure") out.push(err("PSO-DEC-RUNTIME", "$.runtime.restart", 'restart is "no" or "on-failure"'));
      if (d.runtime.restart === "on-failure" && d.runtime.supervisor !== "systemd") out.push(err("PSO-DEC-RUNTIME", "$.runtime.restart", 'automatic restart is performed by systemd: set supervisor: "systemd"'));
    }
  }
  const ng = d.proxy?.nginx;
  if (ng) {
    if (ng.attachPoint !== undefined && (typeof ng.attachPoint !== "boolean" || (isObj(st) && st["type"] === "static"))) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.attachPoint", "attachPoint is a boolean of an application that serves through nginx (not of a static frontend)"));
    if (ng.attachTo !== undefined) {
      const sv0 = (d.services ?? (d.service ? [d.service] : []))[0];
      if (typeof ng.attachTo !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(ng.attachTo)) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.attachTo", "attachTo is the name of the application whose server this shell joins"));
      if (!(sv0?.runtime === "static" && sv0.static?.kind === "fei")) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.attachTo", "only the shell of a frontend (static, kind fei) attaches to another application's server"));
      if (ng.domains || ng.tls || ng.listen || ng.layout) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx", "an attached shell has no server of its own: domains, tls, listen and layout belong to the host application"));
      if (sv0?.static?.api) out.push(err("PSO-DEC-NGINX", "$.services[0].static.api", "an attached shell reaches the orchestrator through the host server's own routes; declare no api"));
    }
    if (ng.domains && !ng.domains.every((x) => /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(x))) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.domains", "invalid domain name"));
    if (ng.layout && ng.layout !== "sites" && ng.layout !== "conf.d" && !/^\/[A-Za-z0-9_./-]+$/.test(ng.layout)) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.layout", 'layout is "sites", "conf.d" or an absolute directory'));
    // these strings are written into an nginx file: only plain path characters, never ";", "{", "}", quotes, spaces or newlines
    const NGINX_PATH = /^\/[A-Za-z0-9_.\/-]{1,200}$/;
    if (ng.tls && typeof ng.tls.certificate === "string" && typeof ng.tls.key === "string" && (!NGINX_PATH.test(ng.tls.certificate) || !NGINX_PATH.test(ng.tls.key) || ng.tls.certificate.includes("..") || ng.tls.key.includes(".."))) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.tls", "certificate and key are absolute file paths of plain characters (letters, digits . _ - /), without \"..\""));
    if (ng.tls && (typeof ng.tls.certificate !== "string" || typeof ng.tls.key !== "string")) out.push(err("PSO-DEC-NGINX", "$.proxy.nginx.tls", "tls names the certificate and key FILE PATHS on the server (PSO never obtains certificates)"));
  }
  if (isObj(st) && st["proxy"] === "nginx" && !(ng && ng.domains && ng.domains.length)) out.push(warn("PSO-DEC-NGINX-DOMAIN", "$.proxy.nginx.domains", "no domain: the virtual host answers as the default server for its port"));
  if (d.migrations) {
    if (!["none", "expand-contract"].includes(d.migrations.mode)) out.push(err("PSO-DEC-MIGRATION", "$.migrations.mode", 'mode is "none" or "expand-contract"'));
    const selfMigrating = services.some((x) => x?.workload?.selfMigrates === true); // the application applies its own migrations at start: PSO has no command to run
    if (d.migrations.mode === "expand-contract" && !selfMigrating && !isArgv(d.migrations.command)) out.push(err("PSO-DEC-MIGRATION", "$.migrations.command", "the migration command is an argv array"));
    if (d.migrations.destructive && d.migrations.approvedDestructive !== true) out.push(warn("PSO-DEC-MIGRATION-DESTRUCTIVE", "$.migrations", "destructive migration: the deployment is blocked until the plan is approved with approvedDestructive: true; application rollback will not undo it"));
  }
  if (d.ports && !(d.ports.from >= 1024 && d.ports.to <= 65535 && d.ports.from < d.ports.to)) out.push(err("PSO-DEC-PORT", "$.ports", "ports is a range inside 1024-65535"));
  return out;
}

export function validatePipeline(raw: unknown): DeclDiagnostic[] {
  const out: DeclDiagnostic[] = [];
  if (!isObj(raw)) return [err("PSO-PIPE-SHAPE", "$", "a pipeline declaration is an object")];
  scanSecrets(raw, "$", out);
  const p = raw as unknown as PipelineDecl;
  if (typeof p.name !== "string" || !KEBAB.test(p.name)) out.push(err("PSO-PIPE-NAME", "$.name", "name is kebab-case"));
  if (!Array.isArray(p.stages) || p.stages.length === 0) { out.push(err("PSO-PIPE-STAGES", "$.stages", "declare at least one stage")); return out; }
  const ids = new Set<string>();
  const TYPES: StageType[] = ["integrity", "compatibility", "security", "tests", "resources", "build", "health", "deploy", "custom"];
  p.stages.forEach((s, i) => {
    const path = `$.stages[${i}]`;
    if (!isObj(s) || !TYPES.includes(s.type)) { out.push(err("PSO-PIPE-STAGE", path, `stage type is one of ${TYPES.join(", ")}`)); return; }
    const id = s.id ?? s.type;
    if (ids.has(id)) out.push(err("PSO-PIPE-STAGE", path, `duplicate stage id "${id}"${s.type === "custom" ? " (give each custom stage an id)" : ""}`)); else ids.add(id);
    if (s.enabled !== undefined && typeof s.enabled !== "boolean") out.push(err("PSO-PIPE-STAGE", `${path}.enabled`, "enabled is true or false"));
    if (s.type === "custom" && !isArgv(s.command)) out.push(err("PSO-PIPE-STAGE", `${path}.command`, "a custom stage names an argv array: it runs without a shell and only when the server policy allows custom stages"));
    if (s.type !== "custom" && s.command !== undefined) out.push(err("PSO-PIPE-STAGE", `${path}.command`, "only custom stages run a command"));
    if (s.timeoutSeconds !== undefined && !(s.timeoutSeconds >= 1 && s.timeoutSeconds <= 7200)) out.push(err("PSO-PIPE-STAGE", `${path}.timeoutSeconds`, "1 to 7200 seconds"));
    if (s.onFailure !== undefined && !["fail", "continue"].includes(s.onFailure)) out.push(err("PSO-PIPE-STAGE", `${path}.onFailure`, '"fail" or "continue"'));
    if (s.onFailure === "continue" && ["integrity", "resources", "deploy"].includes(s.type)) out.push(err("PSO-PIPE-STAGE", `${path}.onFailure`, `a failing ${s.type} stage always stops the deployment`));
    if (s.enabled === false && s.type === "deploy") out.push(err("PSO-PIPE-STAGE", path, "the deploy stage cannot be disabled: it is the pipeline's purpose"));
    if (s.enabled === false && (s.type === "integrity" || s.type === "resources")) out.push(warn("PSO-PIPE-MANDATORY", path, `the ${s.type} stage is disabled here, but its safety-critical core still runs: transfer integrity, locking and resource checks are server-side invariants`));
  });
  p.stages.forEach((s, i) => { for (const dep of s?.dependsOn ?? []) if (!ids.has(dep)) out.push(err("PSO-PIPE-DEPENDS", `$.stages[${i}].dependsOn`, `unknown stage "${dep}"`)); });
  const deps = new Map(p.stages.map((s) => [s.id ?? s.type, s.dependsOn ?? []] as const));
  const state = new Map<string, number>();
  const visit = (n: string): boolean => { if (state.get(n) === 1) return true; if (state.get(n) === 2) return false; state.set(n, 1); for (const m of deps.get(n) ?? []) if (visit(m)) return true; state.set(n, 2); return false; };
  for (const n of deps.keys()) if (visit(n)) { out.push(err("PSO-PIPE-CYCLE", "$.stages", "stage dependencies form a cycle")); break; }
  return out;
}

export const declarationHash = (v: unknown): string => sha256(canonical(v));

/** The pipeline used when a deployment names none: every standard stage; project tests are the project's choice, so they are off. */
export const DEFAULT_PIPELINE: PipelineDecl = {
  name: "default",
  stages: [
    { type: "integrity" }, { type: "compatibility" }, { type: "security" }, { type: "tests", enabled: false }, { type: "resources" }, { type: "build" }, { type: "health" }, { type: "deploy" },
  ],
};
