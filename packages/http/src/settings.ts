import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flatten, envLayer, isStrictConfig, resolveConfig, type Diagnostic, type Layers } from "@pso/core";

/**
 * Canonical configuration of the HTTP limits and rate limiting. One precedence for every setting, lowest to highest:
 *   defaults  <  pso.config.json  <  pso.config.<environment>.json  <  PSO_CFG_http__limits__maxBodyBytes  <  the documented environment variable
 * so the same key can be set in a file, per environment, or by the platform (containers, CI) without code changes.
 * Values may be \`\${env:NAME}\` references (resolved at start-up, never logged). Credentials may NOT be written into files.
 */
const MAP: ReadonlyArray<readonly [envVar: string, key: string]> = [
  ["MAX_BODY_BYTES", "http.limits.maxBodyBytes"],
  ["MAX_UPSTREAM_RESPONSE_BYTES", "http.limits.maxUpstreamResponseBytes"],
  ["MAX_HEADER_BYTES", "http.limits.maxHeaderBytes"],
  ["UPSTREAM_TIMEOUT_MS", "http.limits.upstreamTimeoutMs"],
  ["UPSTREAM_RESPONSE_TIMEOUT_MS", "http.limits.upstreamResponseTimeoutMs"],
  ["HEADERS_TIMEOUT_MS", "http.limits.headersTimeoutMs"],
  ["REQUEST_TIMEOUT_MS", "http.limits.requestTimeoutMs"],
  ["KEEP_ALIVE_TIMEOUT_MS", "http.limits.keepAliveTimeoutMs"],
  ["MAX_CONNECTIONS", "http.limits.maxConnections"],
  ["MAX_CONCURRENT_REQUESTS", "http.limits.maxConcurrentRequests"],
  ["MAX_UPLOAD_BYTES", "http.limits.maxUploadBytes"],
  ["MAX_MULTIPART_PARTS", "http.limits.maxMultipartParts"],
  ["MAX_CONCURRENT_UPLOADS", "http.limits.maxConcurrentUploads"],
  ["RATE_LIMIT_PER_MINUTE", "http.rateLimit.perMinute"],
  ["RATE_LIMIT_BURST", "http.rateLimit.burst"],
  ["RATE_LIMIT_PROVIDER", "http.rateLimit.provider"],
  ["RATE_LIMIT_REDIS_URL", "http.rateLimit.redisUrl"],
  ["RATE_LIMIT_FAILURE", "http.rateLimit.onFailure"],
  ["RATE_LIMIT_PER_PRINCIPAL", "http.rateLimit.perPrincipal"],
  ["RATE_LIMIT_MAX_KEYS", "http.rateLimit.maxKeys"],
  ["RATE_LIMIT_PREFIX", "http.rateLimit.prefix"],
  ["RATE_LIMIT_TRUSTED_PROXIES", "http.rateLimit.trustedProxies"],
  ["PSO_DIAGNOSTICS_TOKEN", "http.diagnostics.token"],
  ["PSO_LOG_LEVEL", "logging.level"],
  ["PSO_LOG_FORMAT", "logging.format"],
  ["PSO_LOG_COLOR", "logging.color"],
  ["PSO_LOG_ERROR_DETAILS", "logging.errorDetails"],
  ["PSO_READINESS_OPTIONAL", "http.readiness.optional"],
  ["PSO_READINESS_INTERVAL_MS", "http.readiness.intervalMs"],
  ["PSO_READINESS_TIMEOUT_MS", "http.readiness.timeoutMs"],
  ["PSO_SHUTDOWN_GRACE_MS", "http.shutdown.graceMs"],
  ["PSO_SHUTDOWN_CLEANUP_MS", "http.shutdown.cleanupMs"],
];
/** earlier names of the same settings (documented in `pso config`); lower priority than the canonical key */
const LEGACY: Readonly<Record<string, string>> = { "http.limits.maxBodyBytes": "server.maxBodyBytes", "http.limits.upstreamTimeoutMs": "server.upstreamTimeoutMs" };

export class SettingsError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`invalid configuration:\n - ${problems.join("\n - ")}`); this.name = "SettingsError"; this.problems = problems; }
}

const REF = /^\$\{env:([A-Za-z0-9_.-]+)\}$/;
const USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i;

function readJson(file: string, problems: string[]): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("must be a JSON object");
    return v as Record<string, unknown>;
  } catch (e) { problems.push(`cannot read ${file}: ${(e as Error).message}`); return {}; }
}

/**
 * Returns an environment object in which every documented setting variable is filled from the configuration files / PSO_CFG_*
 * when the variable itself is not set. The existing validators then run unchanged on the effective values.
 */
export function effectiveEnv(env: NodeJS.ProcessEnv, projectDir: string | undefined, environment?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (!projectDir) return out;
  const problems: string[] = [];
  const envName = environment ?? env["PSO_ENV"] ?? "development";
  const files = [flatten(readJson(join(projectDir, "pso.config.json"), problems)), flatten(readJson(join(projectDir, `pso.config.${envName}.json`), problems))];
  const cfg = envLayer(env);
  for (const [envVar, key] of MAP) {
    if (env[envVar] !== undefined && env[envVar] !== "") continue; // the variable always wins
    let raw: unknown = cfg[key];
    let from = `PSO_CFG_${key.split(".").join("__")}`;
    if (raw === undefined) for (let i = files.length - 1; i >= 0; i--) if (files[i]![key] !== undefined) { raw = files[i]![key]; from = i === 0 ? "pso.config.json" : `pso.config.${envName}.json`; break; }
    if (raw === undefined && LEGACY[key]) for (let i = files.length - 1; i >= 0; i--) if (files[i]![LEGACY[key]!] !== undefined) { raw = files[i]![LEGACY[key]!]; from = `${i === 0 ? "pso.config.json" : `pso.config.${envName}.json`} (${LEGACY[key]}, legacy name)`; break; }
    if (raw === undefined) continue;
    let value = Array.isArray(raw) ? raw.join(",") : String(raw);
    const m = REF.exec(value);
    if (m) {
      const resolved = env[m[1]!];
      if (resolved === undefined || resolved === "") { problems.push(`${key} (from ${from}) references the environment variable ${m[1]}, which is not set`); continue; }
      value = resolved;
    } else if (key.endsWith(".token") && from.endsWith(".json")) {
      problems.push(`${key} (from ${from}) is a secret and must not be written in a file: set the variable PSO_DIAGNOSTICS_TOKEN or reference it as "\${env:NAME}"`);
      continue;
    } else if (key.endsWith("redisUrl") && USERINFO.test(value)) {
      problems.push(`${key} (from ${from}) contains credentials: store the URL in an environment variable and reference it as "\${env:NAME}"`);
      continue;
    }
    out[envVar] = value;
  }
  if (problems.length) throw new SettingsError(problems);
  return out;
}

/**
 * Checks the project's configuration files and PSO_CFG_* variables against the framework schema at start-up, so a misspelled key is
 * never silently ignored by a running application:
 *   - strict (the production environment, or PSO_CONFIG_STRICT=true): an unknown key stops start-up and names the key and its source;
 *   - otherwise (development, test, staging, or PSO_CONFIG_STRICT=false): every unknown key is returned as a warning to be logged.
 * Values are never part of a diagnostic. Types and ranges stay with the package that owns each setting (it refuses them itself).
 */
export function checkProjectConfig(env: NodeJS.ProcessEnv, projectDir: string | undefined, environment: string = env["PSO_ENV"] ?? "development", strict: boolean = isStrictConfig(env, env["PSO_ENV"] ?? env["NODE_ENV"] ?? "development")): { strict: boolean; warnings: Diagnostic[] } {
  if (!projectDir) return { strict, warnings: [] };
  const problems: string[] = [];
  const layers: Layers = {};
  const base = join(projectDir, "pso.config.json"), envFile = join(projectDir, `pso.config.${environment}.json`);
  if (existsSync(base)) layers.service = { source: "pso.config.json", values: readJson(base, problems) };
  if (existsSync(envFile)) layers["environment-file"] = { source: `pso.config.${environment}.json`, values: readJson(envFile, problems) };
  const vars = envLayer(env);
  if (Object.keys(vars).length) layers["environment-variables"] = { source: "PSO_CFG_* variables", values: vars };
  const unknown = resolveConfig(layers, { strict }).diagnostics.filter((d) => d.code === "PSO_CONFIG_UNKNOWN_KEY");
  if (strict && unknown.length) {
    throw new SettingsError([...unknown.map((d) => `${d.message} in ${d.file ?? "the configuration"}${/^Did you mean/.test(d.hint ?? "") ? ` (${d.hint!.split("?")[0]}?)` : ""}`),
      "strict configuration validation is on (production, or PSO_CONFIG_STRICT=true): fix or remove the keys above; application settings belong under \"app.\""]);
  }
  return { strict, warnings: unknown };
}
