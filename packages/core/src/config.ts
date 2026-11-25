import { diag, cmp, type Diagnostic } from "./diagnostics.ts";

/**
 * Precedence, lowest to highest:
 *   1 framework defaults  2 workspace ("config" in pso.workspace.json)  3 service (pso.config.json)
 *   4 environment file (pso.config.<env>.json)  5 runtime environment variables (PSO_CFG_a__b)  6 explicit CLI --set
 */
export const LAYERS = ["defaults", "workspace", "service", "environment-file", "environment-variables", "cli"] as const;
export type LayerName = (typeof LAYERS)[number];
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;

export type Value = string | number | boolean | string[];
type Kind = "string" | "number" | "boolean" | "string[]" | "list" | "json"; // list = a string or a list of strings
interface Spec { kind: Kind; default?: Value; enum?: string[]; min?: number; max?: number }

/** Typed schema of framework settings. Unknown keys are reported (warning), never silently ignored. */
export const SCHEMA: Record<string, Spec> = {
  "server.host": { kind: "string", default: "127.0.0.1" },
  "server.port": { kind: "number", min: 1024, max: 65535 },
  // legacy names of http.limits.maxBodyBytes / http.limits.upstreamTimeoutMs: still honoured, lower priority than the http.* keys
  "server.maxBodyBytes": { kind: "number", default: 1_048_576, min: 1 },
  "server.upstreamTimeoutMs": { kind: "number", default: 5000, min: 1 },
  // orchestrator HTTP limits (environment variable MAX_BODY_BYTES etc. override these)
  "http.limits.maxBodyBytes": { kind: "number", min: 1, max: 1_073_741_824 },
  "http.limits.maxUpstreamResponseBytes": { kind: "number", min: 1, max: 1_073_741_824 },
  "http.limits.maxHeaderBytes": { kind: "number", min: 1024, max: 1_048_576 },
  "http.limits.upstreamTimeoutMs": { kind: "number", min: 1, max: 600_000 },
  "http.limits.upstreamResponseTimeoutMs": { kind: "number", min: 1, max: 3_600_000 },
  "http.limits.headersTimeoutMs": { kind: "number", min: 1, max: 600_000 },
  "http.limits.requestTimeoutMs": { kind: "number", min: 1, max: 3_600_000 },
  "http.limits.keepAliveTimeoutMs": { kind: "number", min: 1, max: 600_000 },
  "http.limits.maxConnections": { kind: "number", min: 1, max: 1_000_000 },
  "http.limits.maxConcurrentRequests": { kind: "number", min: 0, max: 1_000_000 },
  "http.limits.maxUploadBytes": { kind: "number", min: 1, max: 5_368_709_120 },
  "http.limits.maxMultipartParts": { kind: "number", min: 1, max: 1000 },
  "http.limits.maxConcurrentUploads": { kind: "number", min: 0, max: 100_000 },
  // dependencies that do NOT take the instance out of rotation when they are down (names: dispatch, channels, rateLimit)
  "http.readiness.optional": { kind: "list" },
  "http.readiness.intervalMs": { kind: "number", min: 250, max: 300_000 },
  "http.readiness.timeoutMs": { kind: "number", min: 50, max: 60_000 },
  // how long requests already running may take to finish after shutdown starts; then their connections are closed
  "http.shutdown.graceMs": { kind: "number", min: 0, max: 300_000 },
  // how long releasing the dependents may take after that; grace + cleanup (+1 s) is when the process is ended regardless
  "http.shutdown.cleanupMs": { kind: "number", min: 1000, max: 120_000 },
  // rate limiting (provider "redis" is optional and never started unless selected)
  "http.rateLimit.perMinute": { kind: "number", min: 0 },
  "http.rateLimit.burst": { kind: "number", min: 1 },
  "http.rateLimit.provider": { kind: "string", enum: ["local", "redis"] },
  "http.rateLimit.redisUrl": { kind: "string" },
  "http.rateLimit.onFailure": { kind: "string", enum: ["open", "closed"] },
  "http.rateLimit.perPrincipal": { kind: "boolean" },
  "http.rateLimit.maxKeys": { kind: "number", min: 100, max: 5_000_000 },
  "http.rateLimit.prefix": { kind: "string" },
  "http.rateLimit.trustedProxies": { kind: "list" },
  "http.rateLimit.routes": { kind: "json" },
  // diagnostics endpoint (/_pso/telemetry): off unless a token of 32+ characters is set; the token is a secret (variable or ${env:NAME}, never a file value)
  "http.diagnostics.token": { kind: "string" },
  "security.authentication.provider": { kind: "string", default: "jwt", enum: ["jwt", "custom"] },
  "security.authentication.customProvider": { kind: "string" },
  "security.authentication.issuer": { kind: "string" },
  "security.authentication.audience": { kind: "list" },
  "security.authentication.algorithms": { kind: "list", default: ["ES256", "RS256"] },
  "security.authentication.clockToleranceSeconds": { kind: "number", default: 5, min: 0, max: 60 },
  "security.authentication.maxTokenBytes": { kind: "number", default: 8192, min: 256, max: 16384 },
  "security.authentication.tokenType": { kind: "string" },
  "security.authentication.rolesClaim": { kind: "string", default: "roles" },
  "security.authentication.permissionsClaim": { kind: "string", default: "permissions" },
  "security.authentication.jwks.uri": { kind: "string" },
  "security.authentication.jwks.timeoutMs": { kind: "number", default: 3000, min: 200, max: 15000 },
  "security.authentication.jwks.cacheTtlSeconds": { kind: "number", default: 600, min: 30, max: 86400 },
  "security.authentication.jwks.trustedHosts": { kind: "list" },
  // start-up key load: time to connect, and the overall time the transient-failure retries (exponential backoff with jitter) may take
  "security.authentication.jwks.connectTimeoutMs": { kind: "number", default: 2000, min: 100, max: 15000 },
  "security.authentication.jwks.initDeadlineMs": { kind: "number", default: 20000, min: 0, max: 300000 },
  // an identity provider on a private network: exact "host:port" entries; only the JWKS URI itself, only when it matches one of them
  "security.authentication.jwks.privateHosts": { kind: "list" },
  // PEM file with the certificate authority that signed the JWKS endpoint's certificate (a private CA); verification is never disabled
  "security.authentication.jwks.caFile": { kind: "string" },
  "security.authentication.publicKey.file": { kind: "string" },
  "security.authorization.defaultPolicy": { kind: "string", default: "authenticated", enum: ["authenticated"] },
  "security.propagation.forward": { kind: "string", default: "bearer", enum: ["bearer", "none"] },
  "security.jwt.issuer": { kind: "string" },
  "security.jwt.audience": { kind: "string" },
  "security.jwt.jwksUri": { kind: "string" },
  "security.jwt.publicKeyFile": { kind: "string" },
  "security.jwt.algorithms": { kind: "string[]", default: ["RS256", "ES256"] },
  "security.rateLimit.perMinute": { kind: "number", default: 600, min: 1 },
  "logging.level": { kind: "string", default: "info", enum: ["debug", "info", "warn", "error"] },
  "logging.format": { kind: "string", enum: ["pretty", "json"] },
  "logging.color": { kind: "string", enum: ["auto", "always", "never", "detect"] },
  // development diagnostics: log the message and the stack of an unexpected error (never honoured in production; `pso dev` turns it on)
  "logging.errorDetails": { kind: "boolean", default: false },
  // PSO Dispatch (names mirror the Java pso.dispatch.* properties; durations are strings such as 1s, 500ms, 2m)
  "dispatch.enabled": { kind: "boolean", default: false },
  "dispatch.provider": { kind: "string", default: "none", enum: ["none", "redis", "rabbitmq", "kafka"] },
  "dispatch.maxMessageBytes": { kind: "number", default: 1_048_576, min: 1024, max: 16_777_216 },
  "dispatch.consumer.concurrency": { kind: "number", default: 1, min: 1, max: 64 },
  "dispatch.consumer.batchSize": { kind: "number", default: 10, min: 1, max: 1000 },
  "dispatch.retry.enabled": { kind: "boolean", default: true },
  "dispatch.retry.maxAttempts": { kind: "number", default: 3, min: 1, max: 20 },
  "dispatch.retry.initialDelay": { kind: "string", default: "1s" },
  "dispatch.retry.maxDelay": { kind: "string", default: "30s" },
  "dispatch.retry.multiplier": { kind: "number", default: 2, min: 1, max: 10 },
  "dispatch.deadLetter.enabled": { kind: "boolean", default: true },
  "dispatch.observability.enabled": { kind: "boolean", default: true },
  "dispatch.idempotency.retention": { kind: "string", default: "24h" },
  "dispatch.idempotency.lease": { kind: "string", default: "30s" },
  // where processed event ids are remembered: auto = the provider's Redis when the provider is redis, otherwise this process's memory
  "dispatch.idempotency.store": { kind: "string", default: "auto", enum: ["auto", "memory", "redis"] },
  "dispatch.idempotency.redisUrl": { kind: "string" },
  // publisher authentication (keys are environment-only: PSO_DISPATCH_SIGNING_KEY, PSO_DISPATCH_TRUST_KEY_<SERVICE>)
  "dispatch.trust.mode": { kind: "string", default: "off", enum: ["off", "permissive", "required"] },
  "dispatch.redis.url": { kind: "string" },
  "dispatch.redis.maxLength": { kind: "number", default: 100000, min: 100 },
  "dispatch.redis.minIdle": { kind: "string", default: "60s" },
  "dispatch.redis.block": { kind: "string", default: "2s" },
  "dispatch.redis.streamCreation": { kind: "string", default: "auto", enum: ["auto", "require"] },
  "dispatch.rabbitmq.url": { kind: "string" },
  "dispatch.rabbitmq.exchangePrefix": { kind: "string", default: "pso." },
  "dispatch.kafka.brokers": { kind: "list" },
  "dispatch.kafka.clientId": { kind: "string" },
  "dispatch.kafka.topicCreation": { kind: "string", default: "auto", enum: ["auto", "require"] },
  "dispatch.kafka.partitions": { kind: "number", default: 1, min: 1, max: 1000 },
  "dispatch.kafka.replicationFactor": { kind: "number", default: 1, min: 1, max: 10 },
  "dispatch.kafka.ssl": { kind: "boolean", default: false },
  "dispatch.kafka.sasl.mechanism": { kind: "string", enum: ["plain", "scram-sha-256", "scram-sha-512"] },
  "dispatch.kafka.sasl.username": { kind: "string" },
  "dispatch.kafka.sasl.password": { kind: "string" },
};

export interface Resolved { value: Value; origin: LayerName; source: string }

export type Layers = Partial<Record<LayerName, { source: string; values: Record<string, unknown> }>>;

export function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = obj;
  return out;
}

const SECRET_KEY = /(secret|password|passwd|token|private|credential|apikey|api_key)/i;
const REFERENCE = /^\$\{(env|secret|file):[A-Za-z0-9_./-]+\}$/;
export const isReference = (v: unknown): boolean => typeof v === "string" && REFERENCE.test(v);
export const isSecretKey = (k: string): boolean => SECRET_KEY.test(k);

/** Environment variables PSO_CFG_server__port=9000  ->  server.port */
export function envLayer(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("PSO_CFG_") || v === undefined) continue;
    out[k.slice(8).split("__").join(".")] = coerce(v);
  }
  return out;
}

export function coerce(v: string): Value {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.includes(",") && !v.includes(" ")) return v.split(",");
  return v;
}

/**
 * Namespaces whose keys are owned and validated elsewhere, so this schema neither knows nor rejects them:
 *   channels.*              validated by @pso/channels at start-up (unknown keys there stop the process)
 *   http.upstreams.<name>.* per-upstream security policy, validated by @pso/http at start-up
 *   app.*                   reserved for the application's own settings: the framework never reads or judges them
 */
export const OPEN_NAMESPACES = ["channels.", "http.upstreams.", "app."] as const;
const isOpenKey = (key: string): boolean => OPEN_NAMESPACES.some((p) => key.startsWith(p));

/**
 * Strict validation turns an unknown key from a warning into an error. Policy: strict when PSO_CONFIG_STRICT=true, never when
 * PSO_CONFIG_STRICT=false, otherwise strict exactly in the production environment. Development, test and staging keep warnings.
 */
export function isStrictConfig(env: Record<string, string | undefined>, environment: string): boolean {
  const v = env["PSO_CONFIG_STRICT"];
  if (v === "true") return true;
  if (v === "false") return false;
  return environment === "production";
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return row[b.length]!;
}
/** The known key a misspelled one most likely meant (case-insensitive, small edit distance), if any. */
export function nearestKey(key: string, known: readonly string[] = Object.keys(SCHEMA)): string | undefined {
  const k = key.toLowerCase();
  let best: string | undefined, bestD = Math.max(2, Math.floor(key.length / 5)) + 1;
  for (const c of known) { if (Math.abs(c.length - key.length) >= bestD) continue; const d = distance(k, c.toLowerCase()); if (d < bestD) { best = c; bestD = d; } }
  return best;
}

export function resolveConfig(layers: Layers, options: { strict?: boolean } = {}): { values: Map<string, Resolved>; diagnostics: Diagnostic[] } {
  const values = new Map<string, Resolved>();
  const diagnostics: Diagnostic[] = [];
  for (const [key, spec] of Object.entries(SCHEMA)) if (spec.default !== undefined) values.set(key, { value: spec.default, origin: "defaults", source: "framework" });

  for (const name of LAYERS) {
    const layer = layers[name];
    if (!layer) continue;
    const flat = flatten(layer.values);
    for (const key of Object.keys(flat).sort(cmp)) {
      const raw = flat[key];
      const spec = SCHEMA[key];
      if (!spec && !isOpenKey(key)) { // an open namespace is owned and validated by another package (the secret rule below still applies)
        // never silently ignored: a warning in development, an error under strict validation (production, CI). The value is never printed.
        const near = nearestKey(key);
        diagnostics.push(diag(options.strict ? "error" : "warning", "PSO_CONFIG_UNKNOWN_KEY", `Unknown configuration key "${key}"`, layer.source, (near ? `Did you mean "${near}"? ` : "") + "Check the spelling; known keys: " + Object.keys(SCHEMA).join(", ")));
        if (options.strict) continue; // a rejected key never becomes an effective value
      }
      if (isSecretKey(key) && typeof raw === "string" && !isReference(raw) && name !== "environment-variables" && name !== "cli") {
        diagnostics.push(diag("error", "PSO_CONFIG_PLAINTEXT_SECRET", `"${key}" looks like a secret stored as plain text`, layer.source, 'Reference it instead: "${env:NAME}" or "${secret:NAME}"'));
        continue;
      }
      if (spec && !isReference(raw)) {
        const bad = checkType(key, raw, spec);
        if (bad) { diagnostics.push(diag("error", "PSO_CONFIG_INVALID_VALUE", bad, layer.source)); continue; }
      }
      values.set(key, { value: raw as Value, origin: name, source: layer.source });
    }
  }
  diagnostics.push(...contradictions(values));
  return { values, diagnostics };
}

/**
 * Settings that cannot both hold. Reported as warnings here because the missing half may still arrive through a documented
 * environment variable this resolver does not read (PSO_DISPATCH_PROVIDER, RATE_LIMIT_REDIS_URL...); the owning package refuses the
 * combination at start-up, where every source is known.
 */
function contradictions(values: Map<string, Resolved>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const v = (k: string): unknown => values.get(k)?.value;
  const src = (k: string): string | undefined => values.get(k)?.source;
  const warn = (message: string, file: string | undefined, hint: string): void => { out.push(diag("warning", "PSO_CONFIG_CONTRADICTION", message, file, hint)); };
  if (v("dispatch.enabled") === true && (v("dispatch.provider") ?? "none") === "none") warn('"dispatch.enabled" is true but "dispatch.provider" is "none"', src("dispatch.enabled"), "Select a provider (redis, rabbitmq, kafka) or set PSO_DISPATCH_PROVIDER; start-up fails otherwise");
  if (v("http.rateLimit.provider") === "redis" && v("http.rateLimit.redisUrl") === undefined) warn('"http.rateLimit.provider" is "redis" but "http.rateLimit.redisUrl" is not set', src("http.rateLimit.provider"), 'Set it as "${env:NAME}" or set RATE_LIMIT_REDIS_URL; start-up fails otherwise');
  if (v("dispatch.kafka.sasl.mechanism") !== undefined && v("dispatch.kafka.ssl") !== true) warn('"dispatch.kafka.sasl.mechanism" is set but "dispatch.kafka.ssl" is not true', src("dispatch.kafka.sasl.mechanism"), "SASL credentials must travel over TLS; start-up fails otherwise");
  if (v("security.authentication.jwks.uri") !== undefined && v("security.authentication.publicKey.file") !== undefined) warn('both "security.authentication.jwks.uri" and "security.authentication.publicKey.file" are set', src("security.authentication.jwks.uri"), "Configure exactly one source of verification keys");
  return out;
}

function checkType(key: string, v: unknown, spec: Spec): string | undefined {
  if (spec.kind === "json") return undefined; // structured value, validated by its owner
  const ok = spec.kind === "string[]" ? Array.isArray(v) && v.every((x) => typeof x === "string") : spec.kind === "list" ? typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")) : typeof v === spec.kind;
  if (!ok) return `"${key}" must be a ${spec.kind} (got ${isSecretKey(key) ? `a ${Array.isArray(v) ? "list" : typeof v}` : JSON.stringify(v)})`; // a secret's value is never echoed
  if (spec.enum && !spec.enum.includes(v as string)) return `"${key}" must be one of ${spec.enum.join(", ")}`;
  if (typeof v === "number") {
    if (spec.min !== undefined && v < spec.min) return `"${key}" must be >= ${spec.min}`;
    if (spec.max !== undefined && v > spec.max) return `"${key}" must be <= ${spec.max}`;
  }
  return undefined;
}

export const REDACTED = "***REDACTED***";

/** Values safe to print: secret-looking keys never show a literal value; references are shown as references. */
export function redact(key: string, r: Resolved): Value {
  if (isReference(r.value)) return r.value;
  return isSecretKey(key) ? REDACTED : r.value;
}

/** Sets obj.a.b.c = v for the dotted path "a.b.c" (rejects prototype-polluting segments). */
export function setIn(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split(".");
  if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype" || p === "")) throw new Error(`Invalid configuration path "${path}"`);
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = v;
}
