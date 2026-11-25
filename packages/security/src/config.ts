import { existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { envLayer, resolveConfig, type Layers } from "@pso/core";
import { SecurityConfigError, type ConfigIssue } from "./errors.ts";
import { isBlockedAddress, isLoopbackHost } from "./net.ts";

export const ASYMMETRIC_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;
export type Algorithm = (typeof ASYMMETRIC_ALGORITHMS)[number];

export interface JwksSource {
  kind: "jwks";
  uri: URL;
  timeoutMs: number;
  cacheTtlMs: number;
  /** minimum time between refreshes triggered by unknown key ids */
  cooldownMs: number;
  /** how long cached keys may be served while refreshes keep failing */
  maxStaleMs: number;
  maxBytes: number;
  /** time allowed to establish the connection (TCP and TLS) of one attempt */
  connectTimeoutMs?: number;
  /** overall time the start-up key load may take, retries included; 0 = one attempt */
  initDeadlineMs?: number;
  /** the JWKS URI's own host:port was approved as a private identity provider: its private-network addresses are accepted */
  privateAllowed?: boolean;
  /** PEM bundle of the certificate authority to verify the endpoint with (a private CA) */
  caFile?: string;
  trustedHosts: string[];
  /** loopback http is allowed (never in production) */
  loopbackAllowed: boolean;
}
export interface PemSource { kind: "pem"; file: string }

export interface SecurityConfig {
  environment: string;
  authentication: {
    provider: "jwt" | "custom";
    issuer: string;
    audiences: string[];
    algorithms: Algorithm[];
    clockToleranceSeconds: number;
    maxTokenBytes: number;
    tokenType?: string;
    rolesClaim: string;
    permissionsClaim: string;
    key: JwksSource | PemSource;
  };
  authorization: { defaultPolicy: "authenticated" };
  propagation: { forward: "bearer" | "none" };
}

export interface LoadOptions {
  /** the orchestrator project directory (where pso.config.json lives) */
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  /** development | test | staging | production (default: PSO_ENV or development) */
  environment?: string;
}

const ENV_ALIASES: Record<string, string> = {
  PSO_JWT_ISSUER: "security.authentication.issuer",
  PSO_JWT_AUDIENCE: "security.authentication.audience",
  PSO_JWT_JWKS_URI: "security.authentication.jwks.uri",
  PSO_JWT_PUBLIC_KEY_FILE: "security.authentication.publicKey.file",
  PSO_JWT_ALGORITHMS: "security.authentication.algorithms",
  PSO_JWT_JWKS_PRIVATE_HOSTS: "security.authentication.jwks.privateHosts",
  PSO_JWT_JWKS_CA_FILE: "security.authentication.jwks.caFile",
  PSO_JWT_JWKS_TRUSTED_HOSTS: "security.authentication.jwks.trustedHosts",
  PSO_JWT_JWKS_TIMEOUT_MS: "security.authentication.jwks.timeoutMs",
  PSO_JWT_JWKS_CONNECT_TIMEOUT_MS: "security.authentication.jwks.connectTimeoutMs",
  PSO_JWT_JWKS_INIT_DEADLINE_MS: "security.authentication.jwks.initDeadlineMs",
};
const NUMERIC_ALIASES = new Set(["PSO_JWT_JWKS_TIMEOUT_MS", "PSO_JWT_JWKS_CONNECT_TIMEOUT_MS", "PSO_JWT_JWKS_INIT_DEADLINE_MS"]);
const LEGACY: Record<string, string> = {
  "security.jwt.issuer": "security.authentication.issuer",
  "security.jwt.audience": "security.authentication.audience",
  "security.jwt.jwksUri": "security.authentication.jwks.uri",
  "security.jwt.publicKeyFile": "security.authentication.publicKey.file",
  "security.jwt.algorithms": "security.authentication.algorithms",
};

function readJson(file: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("must be a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    issues.push({ code: "PSO_SEC_CONFIG_FILE", message: `cannot read ${file}: ${(e as Error).message}` });
    return undefined;
  }
}

/** The authentication mode DECLARED in configuration. "custom" is the only way a project guard may replace the framework jwt guard. */
export interface AuthenticationMode { provider: "jwt" | "custom"; customProvider?: string; issues: ConfigIssue[] }
export function readAuthenticationMode(projectDir: string, env: NodeJS.ProcessEnv = process.env, environment?: string): AuthenticationMode {
  const issues: ConfigIssue[] = [];
  const envName = environment ?? env["PSO_ENV"] ?? "development";
  const files = [readJson(join(projectDir, "pso.config.json"), issues), readJson(join(projectDir, `pso.config.${envName}.json`), issues)];
  const pick = (name: string): string | undefined => {
    let found: string | undefined;
    for (const f of files) {
      const v = ((f?.["security"] as Record<string, unknown> | undefined)?.["authentication"] as Record<string, unknown> | undefined)?.[name];
      if (typeof v === "string" && v !== "") found = v; // later layers win
    }
    const fromEnv = env[name === "provider" ? "PSO_AUTH_PROVIDER" : "PSO_AUTH_CUSTOM_PROVIDER"];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : found;
  };
  const raw = pick("provider") ?? "jwt";
  if (raw !== "jwt" && raw !== "custom") { issues.push({ code: "PSO_SEC_PROVIDER", key: "security.authentication.provider", message: `security.authentication.provider must be "jwt" or "custom" (got ${JSON.stringify(raw.slice(0, 40))})` }); return { provider: "jwt", issues }; }
  const customProvider = pick("customProvider");
  return { provider: raw, ...(customProvider ? { customProvider } : {}), issues };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : []).map((x) => x.trim()).filter(Boolean);

/**
 * Loads and validates the security configuration. Precedence, lowest to highest:
 *   defaults, pso.config.json, pso.config.<environment>.json, PSO_CFG_* variables, PSO_JWT_* variables.
 * Values may be `${env:NAME}` references; resolved values are never logged or returned by describe().
 * Every problem is collected and reported together; there is no insecure fallback.
 */
export function loadSecurityConfig(opts: LoadOptions): SecurityConfig {
  const env = opts.env ?? process.env;
  const environment = opts.environment ?? env["PSO_ENV"] ?? "development";
  const issues: ConfigIssue[] = [];
  const layers: Layers = {};

  const base = readJson(join(opts.projectDir, "pso.config.json"), issues);
  if (base) layers.service = { source: "pso.config.json", values: base };
  const envFile = readJson(join(opts.projectDir, `pso.config.${environment}.json`), issues);
  if (envFile) layers["environment-file"] = { source: `pso.config.${environment}.json`, values: envFile };
  const fromEnv: Record<string, unknown> = { ...envLayer(env) };
  const flat: Record<string, unknown> = {};
  for (const [v, key] of Object.entries(ENV_ALIASES)) {
    if (env[v] === undefined || env[v] === "") continue;
    if (!NUMERIC_ALIASES.has(v)) { flat[key] = env[v]; continue; }
    if (/^\d+$/.test(env[v]!.trim())) flat[key] = Number(env[v]); else issues.push({ code: "PSO_SEC_NUMBER", key, message: `${v} must be a whole number of milliseconds` });
  }
  if (Object.keys(fromEnv).length || Object.keys(flat).length) layers["environment-variables"] = { source: "environment", values: nest({ ...flatten(fromEnv), ...flat }) };

  const resolved = resolveConfig(layers);
  for (const d of resolved.diagnostics) if (d.severity === "error") issues.push({ code: d.code, message: d.message });

  const refIssue = (key: string, name: string) => issues.push({ code: "PSO_SEC_ENV_MISSING", key, message: `environment variable ${name} (referenced here) is not set` });
  const get = (key: string): unknown => {
    let v = resolved.values.get(key)?.value;
    if (v === undefined) { const legacy = Object.entries(LEGACY).find(([, n]) => n === key)?.[0]; if (legacy) v = resolved.values.get(legacy)?.value; }
    const deref = (x: unknown): unknown => {
      if (typeof x !== "string") return x;
      const m = /^\$\{(env|secret|file):([A-Za-z0-9_./-]+)\}$/.exec(x);
      if (!m) return x;
      if (m[1] !== "env") { issues.push({ code: "PSO_SEC_REF_UNSUPPORTED", key, message: `only \${env:NAME} references are supported for security settings` }); return undefined; }
      const val = env[m[2]!];
      if (val === undefined || val === "") { refIssue(key, m[2]!); return undefined; }
      return val;
    };
    return Array.isArray(v) ? v.map(deref) : deref(v);
  };

  const issuer = String(get("security.authentication.issuer") ?? "");
  if (!issuer) issues.push({ code: "PSO_SEC_MISSING", key: "security.authentication.issuer", message: "issuer is required (PSO_JWT_ISSUER)" });
  const audiences = list(get("security.authentication.audience"));
  if (audiences.length === 0) issues.push({ code: "PSO_SEC_MISSING", key: "security.authentication.audience", message: "audience is required (PSO_JWT_AUDIENCE)" });

  const algRaw = list(get("security.authentication.algorithms"));
  const algorithms = (algRaw.length ? algRaw : ["ES256", "RS256"]) as Algorithm[];
  for (const a of algorithms) {
    if (!(ASYMMETRIC_ALGORITHMS as readonly string[]).includes(a)) issues.push({ code: "PSO_SEC_ALGORITHM", key: "security.authentication.algorithms", message: `unsupported algorithm "${a}": only asymmetric signature algorithms are accepted (${ASYMMETRIC_ALGORITHMS.join(", ")}); HS* and "none" are refused` });
  }

  const jwksRaw = get("security.authentication.jwks.uri");
  const pemRaw = get("security.authentication.publicKey.file");
  let key: JwksSource | PemSource | undefined;
  if (jwksRaw && pemRaw) issues.push({ code: "PSO_SEC_KEY_CONFLICT", message: "configure exactly one key source: jwks.uri or publicKey.file, not both" });
  else if (!jwksRaw && !pemRaw) issues.push({ code: "PSO_SEC_MISSING", message: "a key source is required: security.authentication.jwks.uri (PSO_JWT_JWKS_URI) or security.authentication.publicKey.file (PSO_JWT_PUBLIC_KEY_FILE)" });
  else if (jwksRaw) key = jwks(String(jwksRaw), issuer, environment, get, issues);
  else {
    const file = String(pemRaw);
    if (file.includes("\0")) issues.push({ code: "PSO_SEC_PEM_PATH", key: "security.authentication.publicKey.file", message: "the path contains a NUL byte" });
    else {
      const abs = isAbsolute(file) ? file : resolve(opts.projectDir, file);
      key = { kind: "pem", file: abs };
      if (!existsSync(abs) || !statSync(abs).isFile()) issues.push({ code: "PSO_SEC_PEM_PATH", key: "security.authentication.publicKey.file", message: `public key file not found or not a regular file: ${file}` });
    }
  }

  if (issues.length || !key) throw new SecurityConfigError(issues);
  const num = (k: string, d: number) => { const v = resolved.values.get(k)?.value; return typeof v === "number" ? v : d; };
  const tokenType = get("security.authentication.tokenType");
  return {
    environment,
    authentication: {
      provider: "jwt", issuer, audiences, algorithms,
      clockToleranceSeconds: num("security.authentication.clockToleranceSeconds", 5), maxTokenBytes: num("security.authentication.maxTokenBytes", 8192),
      ...(typeof tokenType === "string" && tokenType ? { tokenType } : {}),
      rolesClaim: String(get("security.authentication.rolesClaim") ?? "roles"), permissionsClaim: String(get("security.authentication.permissionsClaim") ?? "permissions"),
      key,
    },
    authorization: { defaultPolicy: "authenticated" },
    propagation: { forward: get("security.propagation.forward") === "none" ? "none" : "bearer" },
  };

  function jwks(raw: string, iss: string, envName: string, g: (k: string) => unknown, out: ConfigIssue[]): JwksSource | undefined {
    const K = "security.authentication.jwks.uri";
    let uri: URL;
    try { uri = new URL(raw); } catch { out.push({ code: "PSO_SEC_JWKS_URI", key: K, message: "not a valid URL" }); return undefined; }
    if (uri.username || uri.password) { out.push({ code: "PSO_SEC_JWKS_URI", key: K, message: "credentials in the URL are not allowed" }); return undefined; }
    const loopback = isLoopbackHost(uri.hostname);
    const loopbackAllowed = loopback && envName !== "production";
    if (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopbackAllowed)) {
      out.push({ code: "PSO_SEC_JWKS_INSECURE", key: K, message: uri.protocol === "http:" && loopback ? "http to loopback is a development-only exception and is disabled in production" : "the JWKS endpoint must use https" });
      return undefined;
    }
    const host = uri.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // a private identity provider is approved by naming it exactly: "host:port" of the JWKS URI. The approval covers that endpoint
    // only (https, pinned to the validated address, redirects refused as always); it is not a switch for private networks.
    const port = uri.port || "443";
    const approved = list(g("security.authentication.jwks.privateHosts")).map((h) => h.toLowerCase());
    for (const a of approved) if (!/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?):\d{1,5}$/.test(a)) out.push({ code: "PSO_SEC_JWKS_PRIVATE_HOST", key: "security.authentication.jwks.privateHosts", message: `"${a.slice(0, 80)}" is not host:port (the port is required; wildcards, schemes and paths are not accepted)` });
    const privateAllowed = uri.protocol === "https:" && approved.includes(`${uri.hostname.toLowerCase()}:${port}`);
    if (isIP(host) && isBlockedAddress(host, loopbackAllowed, privateAllowed)) { out.push({ code: "PSO_SEC_JWKS_HOST", key: K, message: "the JWKS host is a private, link-local, metadata or otherwise blocked address (a private identity provider must be approved explicitly: security.authentication.jwks.privateHosts / PSO_JWT_JWKS_PRIVATE_HOSTS = host:port)" }); return undefined; }
    let caFile: string | undefined;
    const caRaw = g("security.authentication.jwks.caFile");
    if (typeof caRaw === "string" && caRaw !== "") {
      caFile = isAbsolute(caRaw) ? caRaw : resolve(opts.projectDir, caRaw);
      let pem = "";
      try { pem = readFileSync(caFile, "utf8"); } catch { /* reported below */ }
      if (!/-----BEGIN CERTIFICATE-----/.test(pem)) { out.push({ code: "PSO_SEC_JWKS_CA", key: "security.authentication.jwks.caFile", message: `the certificate authority file is missing, unreadable or contains no PEM certificate: ${caRaw}` }); return undefined; }
      if (/PRIVATE KEY/.test(pem)) { out.push({ code: "PSO_SEC_JWKS_CA", key: "security.authentication.jwks.caFile", message: "the certificate authority file contains a private key; only certificates belong in it" }); return undefined; }
    }
    const trusted = list(g("security.authentication.jwks.trustedHosts")).map((h) => h.toLowerCase());
    let issuerHost = "";
    try { issuerHost = new URL(iss).hostname.toLowerCase(); } catch { /* the issuer may be a plain identifier */ }
    if (!loopbackAllowed && host !== issuerHost && !trusted.includes(host)) {
      out.push({ code: "PSO_SEC_JWKS_HOST", key: K, message: `the JWKS host "${host}" is not bound to the issuer: it must equal the issuer's host or be listed in security.authentication.jwks.trustedHosts` });
      return undefined;
    }
    const n = (k: string, d: number) => { const v = resolved.values.get(k)?.value; return typeof v === "number" ? v : d; };
    return { kind: "jwks", uri, timeoutMs: n("security.authentication.jwks.timeoutMs", 3000), cacheTtlMs: n("security.authentication.jwks.cacheTtlSeconds", 600) * 1000, cooldownMs: 30_000, maxStaleMs: 3_600_000, maxBytes: 262_144, trustedHosts: trusted, loopbackAllowed, connectTimeoutMs: n("security.authentication.jwks.connectTimeoutMs", 2000), initDeadlineMs: n("security.authentication.jwks.initDeadlineMs", 20_000), privateAllowed, ...(caFile ? { caFile } : {}) };
  }
}

/** A description safe to print: no resolved credentials, only the shape of the configuration. */
export function describeConfig(c: SecurityConfig): Record<string, unknown> {
  const k = c.authentication.key;
  return {
    environment: c.environment,
    authentication: {
      provider: c.authentication.provider, issuer: c.authentication.issuer, audiences: c.authentication.audiences, algorithms: c.authentication.algorithms,
      clockToleranceSeconds: c.authentication.clockToleranceSeconds, maxTokenBytes: c.authentication.maxTokenBytes, tokenType: c.authentication.tokenType ?? null,
      rolesClaim: c.authentication.rolesClaim, permissionsClaim: c.authentication.permissionsClaim,
      key: k.kind === "jwks" ? { kind: "jwks", host: k.uri.host, path: k.uri.pathname, https: k.uri.protocol === "https:", cacheTtlSeconds: k.cacheTtlMs / 1000, timeoutMs: k.timeoutMs, loopbackException: k.loopbackAllowed && k.uri.protocol === "http:" } : { kind: "pem", file: k.file },
    },
    authorization: c.authorization, propagation: c.propagation,
  };
}

function flatten(o: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else if (prefix) out[prefix] = o;
  return out;
}
function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split(".");
    if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue;
    let cur = out;
    for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
    cur[parts[parts.length - 1]!] = v;
  }
  return out;
}
