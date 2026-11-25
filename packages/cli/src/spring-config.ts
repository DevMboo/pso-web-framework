import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePrefix, servicePrefix, type ServiceDecl } from "@pso/core";
import { get, isPlaceholder, parseYaml, resolveDefaults } from "./yaml-lite.ts";

/**
 * Static reading and validation of a PSO Spring Boot service's YAML. It mirrors what the starters check at start-up (typed
 * pso.* properties, strict keys, CORS and JWT rules) so mistakes are found by `pso validate` and `pso security:validate`
 * before the service runs. It never prints values of secret-looking keys.
 */

/** The accepted `pso.*` keys (kebab-case). "*" is a free map key; an array holds the shape of a list of objects. */
export const PSO_SCHEMA: Record<string, unknown> = {
  service: { name: 1, prefix: 1 },
  security: {
    enabled: 1,
    jwt: { "jwks-uri": 1, issuer: 1, audience: 1, algorithms: 1, "clock-skew": 1, "roles-claim": 1, "ca-file": 1, "private-hosts": 1 },
    cors: { enabled: 1, "allowed-origins": 1, "allowed-origin-patterns": 1, "allowed-methods": 1, "allowed-headers": 1, "exposed-headers": 1, "allow-credentials": 1, "max-age": 1 },
    headers: { enabled: 1, "referrer-policy": 1 },
    actuator: { "health-public": 1 },
    rules: [{ path: 1, methods: 1, access: 1, scopes: 1, roles: 1 }],
  },
  http: {
    client: {
      services: {
        "*": {
          "base-url": 1, "connect-timeout": 1, "read-timeout": 1, "max-response-size": 1, "forward-bearer": 1, audience: 1, "allow-insecure-http": 1,
          retry: { "max-attempts": 1, backoff: 1, "retry-non-idempotent": 1 },
          // PEM files (ca-file, cert-file + key-file: what the orchestrator and `pso tls:init` use) or key stores (trust-store, key-store)
          tls: { "ca-file": 1, "cert-file": 1, "key-file": 1, "key-password": 1, "trust-store": 1, "trust-store-password": 1, "trust-store-type": 1, "key-store": 1, "key-store-password": 1, "key-store-type": 1, "server-name": 1 },
        },
      },
    },
  },
  limits: {
    requests: { enabled: 1, "per-minute": 1, burst: 1, "per-principal": 1, provider: 1, "on-failure": 1, "max-keys": 1, "trusted-proxies": 1, routes: 1, "redis-url": 1, "redis-prefix": 1 }, body: { "max-size": 1 }, multipart: { enabled: 1, "max-file-size": 1, "max-request-size": 1 },
    header: { "max-size": 1 }, timeouts: { connection: 1, "async-request": 1 }, concurrency: { "max-requests": 1 },
  },
  dispatch: {
    enabled: 1, provider: 1, "max-message-size": 1, // provider "memory" (pso-dispatch-test) belongs to the test profile only: SPR015
    consumer: { concurrency: 1, "batch-size": 1 },
    retry: { enabled: 1, "max-attempts": 1, "initial-delay": 1, "max-delay": 1, multiplier: 1 },
    "dead-letter": { enabled: 1 }, observability: { enabled: 1 }, idempotency: { retention: 1, lease: 1 },
    redis: { url: 1, "max-length": 1, "min-idle": 1, block: 1, "stream-creation": 1 },
    rabbitmq: { url: 1, "exchange-prefix": 1 },
    kafka: { "bootstrap-servers": 1, "client-id": 1, "topic-creation": 1, partitions: 1, "replication-factor": 1, ssl: 1, sasl: { mechanism: 1, username: 1, password: 1 } },
    outbox: { enabled: 1, "poll-interval": 1, "batch-size": 1, "max-attempts": 1, "retry-backoff": 1, retention: 1 },
    "signing-key": 1, "allow-unauthenticated": 1, trust: { mode: 1, keys: { "*": 1 } }, // publisher authentication (com.pso.dispatch.Trust)
  },
  database: { provider: 1 },
  channels: { enabled: 1, "dispatch-event": 1, "max-payload": 1 },
  storage: {
    provider: 1,
    upload: { "max-size": 1, "allowed-content-types": 1, "allowed-extensions": 1, "allow-unverified-types": 1 },
    download: { "inline-content-types": 1 },
    "signed-url": { enabled: 1, "default-ttl": 1, "max-ttl": 1 },
    scan: { required: 1 },
    metadata: { store: 1 },
    local: { root: 1 },
    s3: { bucket: 1, prefix: 1, region: 1, endpoint: 1, "path-style-access": 1 },
    azure: { endpoint: 1, container: 1, prefix: 1, "connection-string": 1, "copy-timeout": 1 },
  },
  observability: { correlation: { enabled: 1, header: 1 }, "error-details": 1 },
};

export interface Finding { id: string; severity: "critical" | "high" | "medium" | "low"; message: string; remediation: string; file?: string }

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

function unknownKeys(value: unknown, schema: unknown, path: string, out: string[]): void {
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return;
    value.forEach((v, i) => unknownKeys(v, schema[0], `${path}[${i}]`, out));
    return;
  }
  if (schema === 1) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const sch = schema as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = kebab(k);
    if (sch["*"]) { unknownKeys(v, sch["*"], `${path}.${k}`, out); continue; }
    if (!(key in sch)) { out.push(`${path}.${k}`); continue; }
    unknownKeys(v, sch[key], `${path}.${k}`, out);
  }
}

export interface SpringFile { name: string; profile: string | null; data: Record<string, unknown> }

export function readSpringFiles(serviceDir: string): { files: SpringFile[]; errors: Array<{ file: string; message: string }> } {
  const dir = join(serviceDir, "src", "main", "resources");
  const files: SpringFile[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  if (!existsSync(dir)) return { files, errors };
  for (const f of readdirSync(dir).sort()) {
    const m = /^application(?:-([A-Za-z0-9_-]+))?\.ya?ml$/.exec(f);
    if (!m) continue;
    try {
      const data = parseYaml(readFileSync(join(dir, f), "utf8"));
      files.push({ name: f, profile: m[1] ?? null, data: (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown> });
    } catch (e) { errors.push({ file: f, message: (e as Error).message }); }
  }
  return { files, errors };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() !== "" ? v.split(",").map((s) => s.trim()) : []);
const ASYMMETRIC = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"]);

/** Everything a developer or Studio needs to see about a Spring service's configuration, without secret values. */
export function springSummary(root: string, svc: ServiceDecl) {
  const dir = join(root, ...svc.path.split("/"));
  const { files, errors } = readSpringFiles(dir);
  const base = files.find((f) => f.profile === null)?.data ?? {};
  const eff = resolveDefaults(get(base, "pso")) as Record<string, unknown> | undefined ?? {};
  const pom = existsSync(join(dir, "pom.xml")) ? readFileSync(join(dir, "pom.xml"), "utf8") : "";
  const starters = [...pom.replace(/<profiles>[\s\S]*<\/profiles>/, "").matchAll(/<groupId>com\.pso<\/groupId>\s*<artifactId>(pso-[a-z-]+)<\/artifactId>/g)].map((m) => m[1]!).filter((x) => x !== "pso-bom");
  const lombok = /<artifactId>lombok<\/artifactId>/.test(pom);
  const jwt = (get(eff, "security.jwt") ?? {}) as Record<string, unknown>;
  const rules = (get(base, "pso.security.rules") as Array<Record<string, unknown>> | null | undefined) ?? [];
  const clientServices = (get(eff, "http.client.services") ?? {}) as Record<string, Record<string, unknown>>;
  const dispatch = (get(eff, "dispatch") ?? {}) as Record<string, unknown>;
  const configured = (v: unknown) => v !== null && v !== undefined && v !== "" && !isPlaceholder(v);
  return {
    service: { name: String(get(eff, "service.name") ?? svc.name), prefix: (() => { try { const p = get(eff, "service.prefix"); return typeof p === "string" && !isPlaceholder(p) ? normalizePrefix(p) : servicePrefix(svc); } catch { return null; } })(), workspacePrefix: servicePrefix(svc) },
    starters, lombok, profiles: files.filter((f) => f.profile).map((f) => f.profile!),
    security: {
      enabled: get(eff, "security.enabled") !== false,
      jwt: { jwksUri: configured(jwt["jwks-uri"]) ? "set" : "from environment (PSO_JWT_JWKS_URI)", issuer: configured(jwt["issuer"]) ? "set" : "from environment (PSO_JWT_ISSUER)", audience: configured(jwt["audience"]) ? "set" : "from environment (PSO_JWT_AUDIENCE)", algorithms: list(jwt["algorithms"]) },
      cors: { enabled: get(eff, "security.cors.enabled") === true, origins: list(get(eff, "security.cors.allowed-origins")).length, patterns: list(get(eff, "security.cors.allowed-origin-patterns")).length, credentials: get(eff, "security.cors.allow-credentials") === true },
      rules: rules.length, publicRules: rules.filter((r) => String(r["access"]).toUpperCase() === "PUBLIC").length,
    },
    httpClient: { services: Object.entries(clientServices).map(([name, c]) => ({ name, host: (() => { try { return new URL(String(c["base-url"])).host; } catch { return "(from environment)"; } })(), forwardBearer: c["forward-bearer"] === true, mtls: !!get(c, "tls.key-store") })) },
    limits: { perMinute: get(eff, "limits.requests.per-minute"), requestsEnabled: get(eff, "limits.requests.enabled") !== false, bodyMax: get(eff, "limits.body.max-size"), multipart: get(eff, "limits.multipart.enabled") === true, maxConcurrent: get(eff, "limits.concurrency.max-requests") },
    database: { provider: String(get(eff, "database.provider") ?? "none"), localProvider: String(get(resolveDefaults(files.find((f) => f.profile === "local")?.data), "pso.database.provider") ?? "") || null },
    dispatch: { enabled: dispatch["enabled"] === true, provider: String(dispatch["provider"] ?? "none") },
    parseErrors: errors,
  };
}

const DATA_SIZE = /^(\d+)\s*(B|KB|MB|GB|TB)?$/i;
/** Bytes of a Spring DataSize literal, or undefined when it is a placeholder or not understood. */
function dataSize(v: unknown): number | undefined {
  const m = typeof v === "string" ? DATA_SIZE.exec(v.trim()) : typeof v === "number" ? DATA_SIZE.exec(String(v)) : null;
  if (!m) return undefined;
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Number(m[1]) * (mult[(m[2] ?? "B").toUpperCase()] ?? 1);
}
const SECRET_LITERAL = /AccountKey=|SharedAccessSignature|sig=|[A-Za-z0-9+/]{40,}={0,2}/;

/** pso.storage.* rules (ids STO***): what can be known about PSO Storage from the files alone. */
function storageFindings(eff: Record<string, unknown>, f: SpringFile, rel: string, pom: string, add: (x: Finding) => void): void {
  const st = get(eff, "storage") as Record<string, unknown> | undefined;
  if (!st) return;
  const provider = typeof st["provider"] === "string" ? st["provider"].toLowerCase() : undefined;
  if (!provider || isPlaceholder(st["provider"])) return; // storage is off or chosen by the environment
  const prod = f.profile === "prod" || f.profile === "staging";
  if (!["local", "s3", "azure"].includes(provider)) { add({ id: "STO001", severity: "high", message: `unknown pso.storage.provider "${provider}"`, remediation: "Use local, s3 or azure", file: rel }); return; }
  if (f.profile === null && !/<artifactId>pso-storage-spring-boot-starter<\/artifactId>/.test(pom)) add({ id: "STO002", severity: "high", message: "pso.storage.provider is set but the service does not depend on pso-storage-spring-boot-starter", remediation: "Run `pso storage:enable " + provider + "` (adds the starter and the provider SDK)", file: rel });
  if (f.profile === null && provider === "s3" && !/<artifactId>s3<\/artifactId>/.test(pom)) add({ id: "STO003", severity: "high", message: "provider s3 needs software.amazon.awssdk:s3 on the classpath", remediation: "Add the dependency (versions come from pso-bom) or run `pso storage:enable s3`", file: rel });
  if (f.profile === null && provider === "azure" && !/<artifactId>azure-storage-blob<\/artifactId>/.test(pom)) add({ id: "STO003", severity: "high", message: "provider azure needs com.azure:azure-storage-blob (and azure-identity) on the classpath", remediation: "Add the dependencies (versions come from pso-bom) or run `pso storage:enable azure`", file: rel });
  const need = (v: unknown, key: string): void => {
    if (v === undefined || v === null || v === "") add({ id: "STO004", severity: "high", message: `pso.storage.${key} is required for provider ${provider}`, remediation: `Set ${key} (an environment placeholder such as \${PSO_STORAGE_...} is fine)`, file: rel });
  };
  if (provider === "local") { need(get(st, "local.root"), "local.root"); if (prod) add({ id: "STO005", severity: "medium", message: `the local provider is configured in ${f.name}: files live on one instance's disk (lost with the container, not shared between replicas)`, remediation: "Use s3 or azure in staging and production, or mount a persistent volume deliberately", file: rel }); }
  if (provider === "s3") need(get(st, "s3.bucket"), "s3.bucket");
  if (provider === "azure") {
    need(get(st, "azure.container"), "azure.container");
    const conn = get(st, "azure.connection-string");
    if (conn !== undefined && conn !== null && conn !== "") {
      if (prod) add({ id: "STO006", severity: "critical", message: `pso.storage.azure.connection-string in ${f.name}: an account key is refused in staging and production`, remediation: "Use pso.storage.azure.endpoint with a managed identity", file: rel });
      else if (typeof conn === "string" && SECRET_LITERAL.test(conn)) add({ id: "STO006", severity: "high", message: `pso.storage.azure.connection-string in ${f.name} looks like a literal key`, remediation: "Reference an environment variable (${PSO_STORAGE_AZURE_CONNECTION_STRING:}) and keep it for local emulators only", file: rel });
    } else need(get(st, "azure.endpoint"), "azure.endpoint");
  }
  if (get(st, "signed-url.enabled") === true) {
    if (provider === "local") add({ id: "STO007", severity: "low", message: "signed-url.enabled has no effect with the local provider (it cannot sign URLs)", remediation: "Serve files through the authenticated download route", file: rel });
    const ttl = String(get(st, "signed-url.max-ttl") ?? "");
    const m = /^(\d+)(ms|s|m|h|d)?$/.exec(ttl.trim());
    if (m) { const secs = Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2] ?? "s"]!; if (secs > 3600) add({ id: "STO008", severity: "medium", message: `signed-url.max-ttl is ${ttl}: a signed URL is a bearer credential and should live minutes, not hours`, remediation: "Keep it at 5m or less", file: rel }); }
  }
  if (get(st, "upload.allow-unverified-types") === true) add({ id: "STO009", severity: "medium", message: "upload.allow-unverified-types trusts the client's declared type for formats the framework cannot verify", remediation: "List only verifiable types in allowed-content-types, or accept the risk consciously", file: rel });
  const max = dataSize(get(st, "upload.max-size"));
  const mpFile = dataSize(get(eff, "limits.multipart.max-file-size")) ?? 5 * 1024 ** 2;
  if (max !== undefined && max > mpFile) add({ id: "STO010", severity: "medium", message: `upload.max-size (${String(get(st, "upload.max-size"))}) is larger than pso.limits.multipart.max-file-size: the container refuses files above the smaller limit`, remediation: "Raise pso.limits.multipart.max-file-size and max-request-size to match, or lower upload.max-size", file: rel });
  if (f.profile === null && get(eff, "limits.multipart.enabled") !== true) add({ id: "STO011", severity: "medium", message: "storage is configured but pso.limits.multipart.enabled is false: multipart uploads are refused with 415", remediation: "Set pso.limits.multipart.enabled: true (`pso storage:enable` does it)", file: rel });
}

export function validateSpring(root: string, svc: ServiceDecl): Finding[] {
  const dir = join(root, ...svc.path.split("/"));
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const { files, errors } = readSpringFiles(dir);
  for (const e of errors) add({ id: "SPR001", severity: "high", message: `${e.file} cannot be read: ${e.message}`, remediation: "Fix the YAML syntax", file: `${svc.path}/src/main/resources/${e.file}` });
  const pom = existsSync(join(dir, "pom.xml")) ? readFileSync(join(dir, "pom.xml"), "utf8") : "";
  const usesStarter = /<artifactId>pso-spring-boot-starter<\/artifactId>/.test(pom);
  if (!usesStarter) return out; // a hand-written service: nothing PSO-specific to validate
  if (!/<artifactId>lombok<\/artifactId>/.test(pom)) add({ id: "SPR012", severity: "low", message: "Lombok is not a dependency of this service", remediation: "Generated services include org.projectlombok:lombok (provided) and the annotation processor path", file: `${svc.path}/pom.xml` });

  for (const f of files) {
    const rel = `${svc.path}/src/main/resources/${f.name}`;
    const pso = get(f.data, "pso");
    if (pso) {
      const bad: string[] = [];
      unknownKeys(pso, PSO_SCHEMA, "pso", bad);
      for (const k of bad) add({ id: "SPR002", severity: "high", message: `unknown property ${k}: the service refuses to start with it`, remediation: "Fix the spelling (see the configuration reference); unknown pso.* keys are never ignored", file: rel });
    }
    const eff = resolveDefaults(pso) as Record<string, unknown> | undefined;
    if (!eff) continue;
    const algs = list(get(eff, "security.jwt.algorithms"));
    for (const a of algs) if (!ASYMMETRIC.has(a)) add({ id: "SPR003", severity: "critical", message: `pso.security.jwt.algorithms contains "${a}": only asymmetric algorithms are accepted`, remediation: `Use one of ${[...ASYMMETRIC].join(", ")}`, file: rel });
    const jwks = get(eff, "security.jwt.jwks-uri");
    if (typeof jwks === "string" && /^http:\/\//.test(jwks) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(jwks)) add({ id: "SPR004", severity: "high", message: "pso.security.jwt.jwks-uri uses plain http for a non-loopback host", remediation: "Use https", file: rel });
    const cors = (get(eff, "security.cors") ?? {}) as Record<string, unknown>;
    if (cors["enabled"] === true) {
      const origins = list(cors["allowed-origins"]), patterns = list(cors["allowed-origin-patterns"]);
      if (!origins.length && !patterns.length && !isPlaceholder(get(f.data, "pso.security.cors.allowed-origins"))) add({ id: "SPR005", severity: "high", message: "CORS is enabled without allowed origins; the service refuses to start", remediation: "List explicit origins under pso.security.cors.allowed-origins", file: rel });
      for (const o of origins) if (o.includes("*")) add({ id: "SPR005", severity: "critical", message: "a wildcard origin is configured for CORS", remediation: "List exact origins; use allowed-origin-patterns only for a wildcard subdomain", file: rel });
      else if (!/^https?:\/\/[^/\s]+$/.test(o)) add({ id: "SPR005", severity: "high", message: `malformed CORS origin "${o}" (expected scheme://host[:port] with no path)`, remediation: "Use origins exactly as browsers send them", file: rel });
      if (cors["allow-credentials"] === true && patterns.length) add({ id: "SPR005", severity: "critical", message: "CORS credentials cannot be combined with wildcard origin patterns", remediation: "List exact origins for credentialed requests", file: rel });
    }
    const rules = (get(eff, "security.rules") ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(rules)) for (const r of rules) {
      if (String(r["access"]).toUpperCase() === "PUBLIC") add({ id: "SPR006", severity: "medium", message: `public rule for ${String(r["path"])}: no authentication is required`, remediation: "Confirm the path is intentionally public", file: rel });
    }
    const dispatch = (get(eff, "dispatch") ?? {}) as Record<string, unknown>;
    // the in-process test adapter outside the test profile: events would be lost with the process and reach no other service
    if (String(resolveDefaults(dispatch["provider"]) ?? "").toLowerCase() === "memory" && f.profile !== "test") add({ id: "SPR015", severity: "high", message: `pso.dispatch.provider is "memory" in ${f.name}: the in-process adapter is for tests only`, remediation: "Keep provider: memory in application-test.yml; here set the broker the service uses (redis, rabbitmq or kafka)", file: rel });
    if (dispatch["enabled"] === true && (!dispatch["provider"] || dispatch["provider"] === "none")) add({ id: "SPR007", severity: "high", message: "pso.dispatch.enabled is true without a provider", remediation: "Set pso.dispatch.provider after installing a provider starter", file: rel });
    const prov = get(eff, "database.provider");
    if (prov !== undefined && !["none", "h2", "postgresql"].includes(String(prov).toLowerCase())) add({ id: "SPR008", severity: "high", message: `unknown pso.database.provider "${String(prov)}"`, remediation: "Use none, h2 or postgresql", file: rel });
    if (String(prov).toLowerCase() === "h2" && (f.profile === null || f.profile === "prod" || f.profile === "staging")) add({ id: "SPR009", severity: "high", message: `H2 is configured in ${f.name}: it is refused in staging and production, and must not be the default`, remediation: "Select H2 through the local or h2 profile only", file: rel });
    storageFindings(eff, f, rel, pom, add);
    const services = (get(eff, "http.client.services") ?? {}) as Record<string, Record<string, unknown>>;
    for (const [n, c] of Object.entries(services ?? {})) {
      const url = String(c?.["base-url"] ?? "");
      if (/^http:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url) && c["allow-insecure-http"] !== true) add({ id: "SPR010", severity: "high", message: `HTTP client service "${n}" uses plain http for a non-loopback host`, remediation: "Use https (or set allow-insecure-http for a trusted network)", file: rel });
      for (const k of ["trust-store-password", "key-store-password", "key-password"]) {
        const v = get(c, `tls.${k}`);
        if (typeof v === "string" && v !== "" && !isPlaceholder(v)) add({ id: "SPR011", severity: "high", message: `HTTP client service "${n}" has a literal ${k} in ${f.name}`, remediation: "Use an environment placeholder such as ${TLS_PASSWORD}", file: rel });
      }
      // two ways to say the same thing are a start-up error of the service: report it here, before the service is started
      const tls = (get(c, "tls") ?? {}) as Record<string, unknown>;
      const set = (k: string): boolean => typeof tls[k] === "string" && tls[k] !== "";
      if (set("ca-file") && set("trust-store")) add({ id: "SPR014", severity: "high", message: `HTTP client service "${n}" sets both tls.ca-file and tls.trust-store`, remediation: "Keep one: ca-file (PEM, the file the orchestrator uses) or trust-store (PKCS12/JKS)", file: rel });
      if ((set("cert-file") || set("key-file")) && set("key-store")) add({ id: "SPR014", severity: "high", message: `HTTP client service "${n}" sets both tls.cert-file/tls.key-file and tls.key-store`, remediation: "Keep one form of the client certificate", file: rel });
      if (set("cert-file") !== set("key-file")) add({ id: "SPR014", severity: "high", message: `HTTP client service "${n}" sets only one of tls.cert-file and tls.key-file`, remediation: "Mutual TLS needs both the certificate and its private key", file: rel });
    }
  }
  const prefixes = files.filter((f) => f.profile === null).map((f) => resolveDefaults(get(f.data, "pso.service.prefix")));
  const declared = prefixes[0];
  if (typeof declared === "string" && !isPlaceholder(declared)) {
    try { if (normalizePrefix(declared) !== servicePrefix(svc)) add({ id: "SPR013", severity: "high", message: `pso.service.prefix is "${normalizePrefix(declared) || "/"}" but pso.workspace.json says "${servicePrefix(svc) || "/"}" for ${svc.name}: the orchestrator would forward to the wrong path`, remediation: "Make both equal (the workspace declaration is what the orchestrator uses)", file: `${svc.path}/src/main/resources/application.yml` }); }
    catch { add({ id: "SPR013", severity: "high", message: `pso.service.prefix "${declared}" is not a valid prefix`, remediation: "Use lower-case letters, digits and . _ ~ - separated by /", file: `${svc.path}/src/main/resources/application.yml` }); }
  }
  return out;
}
