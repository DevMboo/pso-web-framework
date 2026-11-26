import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `pso.infra.json`: the declarative infrastructure contract of a workspace (0.2.0).
 *
 * It declares only what cannot be derived from the rest of the workspace. Services, ports, dependencies, databases and frontends come
 * from `pso.workspace.json`; routes and scopes from the ROUTES/FEI/MEI declarations. This file adds the things a deployment needs and the
 * application code does not know: which environments exist, under which host names each frontend and the API are reachable, where TLS
 * material and secrets come from in each environment, which identity provider issues tokens, which hops use mutual TLS, and the resource
 * limits of the containers. The file is optional: without it PSO derives a single local development environment.
 *
 * Nothing secret is ever written here. A secret is referenced by name; its value lives in the environment's secret provider.
 */
export const INFRA_FILE = "pso.infra.json";
export const INFRA_DIR = ".infra";
export const INFRA_SCHEMA_VERSION = 1;

export type EnvironmentKind = "development" | "staging" | "production";
/** where TLS material comes from: certificates PSO issues from a local development authority, or certificates the operator supplies */
export type TlsSource = "pso-dev-ca" | "external";
/** where secret values come from */
export type SecretProvider = "local" | "env" | "file";
/** how the stack runs: as local processes (`pso dev`) or as containers (Docker Engine + Compose) */
export type RuntimeMode = "process" | "docker";
export type IdentityProvider = "keycloak" | "pso-dev" | "external" | "none";

export interface EnvironmentDecl {
  kind: EnvironmentKind;
  /** DNS suffix of every host of this environment: a host label `shop` becomes `shop.<domain>` */
  domain: string;
  runtime?: RuntimeMode;
  /** explicit fully-qualified host names that override `<label>.<domain>` (keys: a FEI name, "api" or "identity") */
  hosts?: Record<string, string>;
  /** the public HTTPS port of the edge gateway (443 in production; a free unprivileged port locally) */
  httpsPort?: number;
  /** development only: also publish every service container on 127.0.0.1:<port> (direct testing). Off by default: only the edge is published */
  publishServices?: boolean;
  tls?: { source?: TlsSource; /** directory with the operator's certificates (external source), in the PSO layout */ dir?: string };
  secrets?: { provider?: SecretProvider; /** directory of secret files for the "file" provider (for example /run/secrets) */ dir?: string };
  /** DNS: PSO never creates records by itself. "hosts-file" only proposes (and with explicit authorization writes) a local hosts block. */
  dns?: { provider?: "none" | "hosts-file" | "external"; zone?: string };
  identity?: { issuer?: string; jwksUri?: string; authorizationEndpoint?: string; tokenEndpoint?: string; logoutEndpoint?: string };
  /**
   * where a deployment of this environment goes: the Docker Engine of this machine (`docker`), a Linux host over SSH registered with
   * `pso connection:add` (`ssh`: `connection` names it, `root` is the directory PSO manages there), or a reviewable bundle (`bundle`)
   */
  deploy?: { target?: "docker" | "bundle" | "ssh"; dockerContext?: string; connection?: string; root?: string };
  /** per-environment frontend settings that win over the workspace-wide `frontends` section (written by `pso frontend:config --env`) */
  frontends?: Record<string, { auth?: "oidc" | "dev-token" | "none" }>;
  /** per-environment service settings that win over the workspace-wide `services` section */
  services?: Record<string, EnvironmentServiceDecl>;
  /**
   * Redis in this environment, when the workspace declares `redis`: a container PSO runs (default), a Redis the operator runs elsewhere
   * (`external`: its address is the supplied secret `redis-url`), or none at all in this environment
   */
  redis?: { provider?: RedisProvider; /** process mode: the loopback port of the Redis container of `pso dev --with-dependencies` (default 6379) */ port?: number };
}

/** Where the access tokens a service accepts are configured: by the environment's identity provider (default), or by the application itself. */
export type AuthenticationSource = "infrastructure" | "application";
export type RedisProvider = "container" | "external" | "none";

/** What one environment changes for one service. */
export interface EnvironmentServiceDecl {
  authentication?: AuthenticationSource;
  /** variables of this environment only (merged over `services.<name>.environment`) */
  environment?: Record<string, string>;
  replicas?: number;
}

export interface FrontendInfraDecl {
  /** host label (default: the FEI name without `fei-`) */
  host?: string;
  /** base path the shell is served under (default `/`); two shells may share a host only with non-overlapping base paths */
  basePath?: string;
  /** how users sign in at runtime: OIDC through the declared identity provider (default when the shell authenticates), dev-token, none */
  auth?: "oidc" | "dev-token" | "none";
  /** OIDC client id (default: the FEI name) */
  clientId?: string;
}

export interface ServiceInfraDecl {
  /** the orchestrator must present a client certificate to this service (mutual TLS) */
  mtls?: boolean;
  resources?: ResourceLimits;
  /** names of declared secrets this service receives as files */
  secrets?: string[];
  /**
   * "infrastructure" (default): the service validates tokens of the environment's identity provider, configured by PSO (PSO_JWT_*).
   * "application": the application configures token validation itself; PSO gives this service no identity settings at all, so a
   * key source of the application never meets one of the infrastructure (PSO_SEC_KEY_CONFLICT is then always a real conflict).
   */
  authentication?: AuthenticationSource;
  /**
   * Variables of the application for this service, in every environment: a plain value, or `secret://<declared secret>`. A secret is
   * mounted as a file in a container (Spring reads it as a property of that name, a Node service as the variable) and resolved by
   * `pso dev` for a local process; its value is never written in a generated file. Variables PSO itself manages cannot be set here.
   */
  environment?: Record<string, string>;
  /** persistent named volumes of the container: name -> absolute path inside the container (kept by `pso docker:down`) */
  volumes?: Record<string, string>;
  /** containers of this service in the docker runtime (default 1); the edge balances the orchestrator's instances */
  replicas?: number;
  /** container health check: how long a slow start is tolerated before failures count (default 60s for Spring, 15s for Node) */
  healthcheck?: { startPeriod?: string };
}

/**
 * Redis for the services that need it (PSO Dispatch, the Redis bus of PSO Channels, caches): declared once, provisioned only where it is
 * declared. The container runs on the private network only, requires a password (secret `redis-password`), keeps its data in a named
 * volume and is health-checked; each client receives the address with its credentials (secret `redis-url`) in the variables it names.
 */
export interface RedisDecl {
  /** service name -> the variables that receive the address (default ["REDIS_URL"]); a list of names gives each one REDIS_URL */
  clients: string[] | Record<string, string[]>;
  /** append-only persistence in a named volume (default true) */
  persistence?: boolean;
  resources?: ResourceLimits;
}

export interface ResourceLimits { memory?: string; cpus?: string }

export interface IdentityDecl {
  provider: IdentityProvider;
  realm?: string;
  /** host label of the identity provider (default `auth`) */
  host?: string;
  /** the audience every access token carries (default `pso-api`) */
  audience?: string;
  /** development users created in a PSO-managed identity provider; their passwords are generated secrets, never written here */
  users?: Array<{ username: string; scopes: string[]; email?: string }>;
}

export interface SecretDecl {
  description?: string;
  /** PSO may generate the value in development environments ("random"); production values are always supplied */
  generate?: "random" | false;
}

export interface InfraContract {
  schemaVersion: 1;
  defaultEnvironment?: string;
  environments: Record<string, EnvironmentDecl>;
  identity?: IdentityDecl;
  /** host label of the public API (the orchestrator through the edge gateway), default `api` */
  api?: { host?: string };
  frontends?: Record<string, FrontendInfraDecl>;
  services?: Record<string, ServiceInfraDecl>;
  secrets?: Record<string, SecretDecl>;
  redis?: RedisDecl;
  docker?: { project?: string; logs?: { maxSize?: string; maxFile?: number }; resources?: ResourceLimits; images?: { nginx?: string; postgres?: string; keycloak?: string; redis?: string } };
}

export interface ContractIssue { code: string; severity: "error" | "warning"; message: string; path: string; hint?: string }

export const DEFAULT_IMAGES = { nginx: "nginx:1.27-alpine", postgres: "postgres:17-alpine", keycloak: "quay.io/keycloak/keycloak:26.0", redis: "redis:7.4-alpine" } as const;

/**
 * Variables PSO itself sets for a service (identity, upstreams, TLS, database, ports, secrets, Redis): `environment` cannot override them,
 * so a typo in the contract can never switch off TLS or replace the identity provider. With `authentication: "application"` the identity
 * variables (PSO_JWT_*, PSO_SECURITY_JWT_*) belong to the application and may be set.
 */
export const MANAGED_VARIABLES = /^(PORT|HOST|PSO_ENV|PSO_SERVICE|PSO_WORKSPACE|PSO_UPSTREAM_.*|PSO_HTTP_TLS_.*|PSO_SHUTDOWN_GRACE_MS|SERVER_SSL_.*|SPRING_CONFIG_IMPORT|SPRING_PROFILES_ACTIVE|DB_URL|DB_USER|DB_PASSWORD|PSO_SECRET_FILES|PSO_SECRETS_DIR|NODE_EXTRA_CA_CERTS)$/;
export const IDENTITY_VARIABLES = /^PSO_(JWT|SECURITY_JWT)_[A-Z0-9_]+$/;
/** a variable name that announces a credential: its value must be a secret:// reference, never plain text in the contract */
export const CREDENTIAL_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|CREDENTIAL|SIGNING_KEY|TRUST_KEY)/;
const VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;
const DURATION = /^\d+(ms|s|m)$/;
const VOLUME_TARGET = /^\/[A-Za-z0-9._\/-]+$/;
export const DEFAULT_LOCAL_DOMAIN = "pso.localhost";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FQDN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MEM = /^\d+(\.\d+)?[kmg]$/i;
const CPUS = /^\d+(\.\d+)?$/;
const SIZE = /^\d+[kmg]$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The contract used when the workspace has no pso.infra.json: one local development environment, nothing external. */
export function defaultContract(): InfraContract {
  return { schemaVersion: 1, defaultEnvironment: "local", environments: { local: { kind: "development", domain: DEFAULT_LOCAL_DOMAIN, runtime: "process", httpsPort: 8443, tls: { source: "pso-dev-ca" }, secrets: { provider: "local" }, dns: { provider: "none" } } } };
}

export function loadContract(root: string): { contract: InfraContract; declared: boolean; issues: ContractIssue[] } {
  const file = join(root, INFRA_FILE);
  if (!existsSync(file)) return { contract: defaultContract(), declared: false, issues: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch (e) { return { contract: defaultContract(), declared: true, issues: [{ code: "PSO_INFRA_UNREADABLE", severity: "error", message: `${INFRA_FILE} is not valid JSON: ${(e as Error).message}`, path: "$" }] }; }
  const issues = validateContract(raw);
  return { contract: issues.some((i) => i.severity === "error") ? defaultContract() : (raw as InfraContract), declared: true, issues };
}

/** Shape and consistency of the contract alone; cross-checks against the workspace (unknown service names, host collisions) are in the graph. */
export function validateContract(raw: unknown): ContractIssue[] {
  const out: ContractIssue[] = [];
  currentIssues = out;
  const err = (path: string, code: string, message: string, hint?: string) => out.push({ code, severity: "error", message, path, ...(hint ? { hint } : {}) });
  const warn = (path: string, code: string, message: string, hint?: string) => out.push({ code, severity: "warning", message, path, ...(hint ? { hint } : {}) });
  if (!isObj(raw)) { err("$", "PSO_INFRA_SHAPE", `${INFRA_FILE} must be a JSON object`); return out; }
  if (raw["schemaVersion"] !== INFRA_SCHEMA_VERSION) err("$.schemaVersion", "PSO_INFRA_SCHEMA", `unsupported schemaVersion ${JSON.stringify(raw["schemaVersion"])} (this CLI supports ${INFRA_SCHEMA_VERSION})`);
  const envs = raw["environments"];
  if (!isObj(envs) || Object.keys(envs).length === 0) { err("$.environments", "PSO_INFRA_ENVIRONMENTS", `"environments" must declare at least one environment`, `Example: { "local": { "kind": "development", "domain": "${DEFAULT_LOCAL_DOMAIN}" } }`); return out; }
  for (const [name, e] of Object.entries(envs)) {
    const p = `$.environments.${name}`;
    if (!KEBAB.test(name)) err(p, "PSO_INFRA_ENV_NAME", `environment name "${name}" must be kebab-case`);
    if (!isObj(e)) { err(p, "PSO_INFRA_ENV_SHAPE", "an environment must be an object"); continue; }
    const kind = e["kind"];
    if (kind !== "development" && kind !== "staging" && kind !== "production") err(`${p}.kind`, "PSO_INFRA_ENV_KIND", `"kind" must be development, staging or production`);
    if (typeof e["domain"] !== "string" || !FQDN.test(e["domain"])) err(`${p}.domain`, "PSO_INFRA_DOMAIN", `"domain" must be a DNS name such as ${kind === "development" ? DEFAULT_LOCAL_DOMAIN : "example.com"}`);
    if (e["runtime"] !== undefined && e["runtime"] !== "process" && e["runtime"] !== "docker") err(`${p}.runtime`, "PSO_INFRA_RUNTIME", `"runtime" must be "process" or "docker"`);
    if (e["publishServices"] !== undefined && (typeof e["publishServices"] !== "boolean" || (e["publishServices"] === true && kind !== "development"))) err(`${p}.publishServices`, "PSO_INFRA_PUBLISH", `"publishServices" is a development option (true or false): staging and production publish the edge only`);
    if (e["httpsPort"] !== undefined && (!Number.isInteger(e["httpsPort"]) || (e["httpsPort"] as number) < 1 || (e["httpsPort"] as number) > 65535)) err(`${p}.httpsPort`, "PSO_INFRA_PORT", `"httpsPort" must be a port number`);
    if (isObj(e["hosts"])) for (const [k, h] of Object.entries(e["hosts"])) if (typeof h !== "string" || !FQDN.test(h)) err(`${p}.hosts.${k}`, "PSO_INFRA_HOST", `host "${String(h)}" must be a fully-qualified DNS name`);
    const tls = isObj(e["tls"]) ? e["tls"] : {};
    const source = tls["source"] ?? (kind === "development" ? "pso-dev-ca" : "external");
    if (e["frontends"] !== undefined) {
      if (!isObj(e["frontends"])) err(`${p}.frontends`, "PSO_INFRA_FRONTEND", "must be an object of FEI names");
      else for (const [n, f] of Object.entries(e["frontends"])) {
        if (!isObj(f)) { err(`${p}.frontends.${n}`, "PSO_INFRA_FRONTEND", "must be an object"); continue; }
        for (const k of Object.keys(f)) if (k !== "auth") err(`${p}.frontends.${n}.${k}`, "PSO_INFRA_FRONTEND", `only "auth" can be set per environment (host, basePath and clientId are workspace-wide in $.frontends)`);
        if (f["auth"] !== undefined && !["oidc", "dev-token", "none"].includes(String(f["auth"]))) err(`${p}.frontends.${n}.auth`, "PSO_INFRA_FRONTEND_AUTH", `"auth" must be oidc, dev-token or none`);
        if (f["auth"] === "dev-token" && kind === "production") err(`${p}.frontends.${n}.auth`, "PSO_INFRA_DEV_TOKEN_PRODUCTION", "dev-token sign-in is not accepted in a production environment");
      }
    }
    if (source !== "pso-dev-ca" && source !== "external") err(`${p}.tls.source`, "PSO_INFRA_TLS_SOURCE", `"tls.source" must be "pso-dev-ca" or "external"`);
    // production never runs on certificates nobody trusts: a development authority is refused, not warned about
    if (kind === "production" && source === "pso-dev-ca") err(`${p}.tls.source`, "PSO_INFRA_TLS_PRODUCTION", `a production environment cannot use certificates from the PSO development authority`, `Set "tls": { "source": "external", "dir": "<directory with your certificates>" }`);
    if (kind === "staging" && source === "pso-dev-ca") warn(`${p}.tls.source`, "PSO_INFRA_TLS_STAGING", `staging uses certificates from the PSO development authority: browsers and clients will not trust them unless that authority is installed`);
    if (source === "external" && (typeof tls["dir"] !== "string" || tls["dir"].length === 0)) err(`${p}.tls.dir`, "PSO_INFRA_TLS_DIR", `"tls.dir" is required when the certificates are external`, "The directory holds ca.crt and <name>/tls.crt, tls.key in the PSO layout");
    const sec = isObj(e["secrets"]) ? e["secrets"] : {};
    const prov = sec["provider"] ?? (kind === "development" ? "local" : "env");
    if (prov !== "local" && prov !== "env" && prov !== "file") err(`${p}.secrets.provider`, "PSO_INFRA_SECRETS", `"secrets.provider" must be local, env or file`);
    if (kind !== "development" && prov === "local") err(`${p}.secrets.provider`, "PSO_INFRA_SECRETS_LOCAL", `a ${String(kind)} environment cannot keep its secrets in PSO's local development store`, `Use "env" (variables injected by your platform) or "file" (mounted secret files)`);
    if (prov === "file" && (typeof sec["dir"] !== "string" || !sec["dir"].startsWith("/"))) err(`${p}.secrets.dir`, "PSO_INFRA_SECRETS_DIR", `"secrets.dir" must be an absolute path when the provider is "file"`);
    const dns = isObj(e["dns"]) ? e["dns"] : {};
    if (dns["provider"] !== undefined && !["none", "hosts-file", "external"].includes(String(dns["provider"]))) err(`${p}.dns.provider`, "PSO_INFRA_DNS", `"dns.provider" must be none, hosts-file or external`);
    if (kind !== "development" && dns["provider"] === "hosts-file") err(`${p}.dns.provider`, "PSO_INFRA_DNS_HOSTS", `a hosts file is a development tool; a ${String(kind)} environment needs real DNS records`);
    const dep = isObj(e["deploy"]) ? e["deploy"] : {};
    if (dep["target"] !== undefined && !["docker", "bundle", "ssh"].includes(String(dep["target"]))) err(`${p}.deploy.target`, "PSO_INFRA_DEPLOY_TARGET", `"deploy.target" must be "docker", "ssh" or "bundle"`);
    if (dep["target"] === "ssh" && (typeof dep["connection"] !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(dep["connection"]))) err(`${p}.deploy.connection`, "PSO_INFRA_DEPLOY_CONNECTION", `an ssh deployment names the host connection ("deploy.connection", registered with pso connection:add)`);
    if (dep["root"] !== undefined && (typeof dep["root"] !== "string" || !/^\/[A-Za-z0-9._\/-]+$/.test(dep["root"]) || dep["root"].split("/").includes(".."))) err(`${p}.deploy.root`, "PSO_INFRA_DEPLOY_ROOT", `"deploy.root" must be an absolute POSIX path on the host`);
    if (dep["target"] === "ssh" && kind === "development") warn(`${p}.deploy.target`, "PSO_INFRA_DEPLOY_SSH_DEV", `a development environment deployed to a remote host still uses development certificates and secrets`);
    if (e["services"] !== undefined) {
      if (!isObj(e["services"])) err(`${p}.services`, "PSO_INFRA_SERVICE", "must be an object of service names");
      else for (const [n, sv] of Object.entries(e["services"])) {
        if (!isObj(sv)) { err(`${p}.services.${n}`, "PSO_INFRA_SERVICE", "must be an object"); continue; }
        for (const k of Object.keys(sv)) if (!["authentication", "environment", "replicas"].includes(k)) err(`${p}.services.${n}.${k}`, "PSO_INFRA_SERVICE", `only "authentication", "environment" and "replicas" can be set per environment (the rest is workspace-wide in $.services)`);
        serviceCommon(`${p}.services.${n}`, sv, raw);
      }
    }
    if (e["redis"] !== undefined) {
      const r = e["redis"];
      if (!isObj(r)) err(`${p}.redis`, "PSO_INFRA_REDIS", `"redis" must be an object such as { "provider": "container" }`);
      else {
        if (r["provider"] !== undefined && !["container", "external", "none"].includes(String(r["provider"]))) err(`${p}.redis.provider`, "PSO_INFRA_REDIS", `"redis.provider" must be container, external or none`);
        if (r["port"] !== undefined && (!Number.isInteger(r["port"]) || (r["port"] as number) < 1 || (r["port"] as number) > 65535)) err(`${p}.redis.port`, "PSO_INFRA_PORT", `"redis.port" must be a port number`);
        if (!isObj(raw["redis"])) err(`${p}.redis`, "PSO_INFRA_REDIS", `this environment configures Redis, but the workspace does not declare it ("redis": { "clients": [...] })`);
      }
    }
    const id = isObj(e["identity"]) ? e["identity"] : {};
    for (const k of ["issuer", "jwksUri", "authorizationEndpoint", "tokenEndpoint", "logoutEndpoint"]) if (id[k] !== undefined && (typeof id[k] !== "string" || !/^https:\/\/[^\s]+$/.test(id[k] as string))) err(`${p}.identity.${k}`, "PSO_INFRA_IDENTITY_URL", `"identity.${k}" must be an https:// URL`);
  }
  if (raw["defaultEnvironment"] !== undefined && (typeof raw["defaultEnvironment"] !== "string" || !Object.hasOwn(envs, raw["defaultEnvironment"]))) err("$.defaultEnvironment", "PSO_INFRA_DEFAULT_ENV", `"defaultEnvironment" must name a declared environment`);
  const idn = raw["identity"];
  if (idn !== undefined) {
    if (!isObj(idn)) err("$.identity", "PSO_INFRA_IDENTITY", `"identity" must be an object`);
    else {
      if (!["keycloak", "pso-dev", "external", "none"].includes(String(idn["provider"]))) err("$.identity.provider", "PSO_INFRA_IDENTITY", `"identity.provider" must be keycloak, pso-dev, external or none`);
      if (idn["realm"] !== undefined && (typeof idn["realm"] !== "string" || !KEBAB.test(idn["realm"]))) err("$.identity.realm", "PSO_INFRA_IDENTITY", `"identity.realm" must be kebab-case`);
      if (idn["host"] !== undefined && (typeof idn["host"] !== "string" || !LABEL.test(idn["host"]))) err("$.identity.host", "PSO_INFRA_HOST", `"identity.host" must be a DNS label`);
      if (Array.isArray(idn["users"])) (idn["users"] as unknown[]).forEach((u, i) => {
        if (!isObj(u) || typeof u["username"] !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(u["username"]) || !Array.isArray(u["scopes"])) err(`$.identity.users[${i}]`, "PSO_INFRA_IDENTITY_USER", `a development user needs "username" (lower-case) and "scopes" (a list)`);
        else if (Object.keys(u).some((k) => /pass|secret|credential/i.test(k))) err(`$.identity.users[${i}]`, "PSO_INFRA_SECRET_IN_CONTRACT", `user "${u["username"]}" carries a credential: passwords are generated secrets and never written in ${INFRA_FILE}`);
      });
      if (idn["provider"] === "external") for (const [n, e] of Object.entries(envs)) { const id = isObj(e) && isObj(e["identity"]) ? e["identity"] : {}; if (!id["issuer"] || !id["jwksUri"]) err(`$.environments.${n}.identity`, "PSO_INFRA_IDENTITY_EXTERNAL", `an external identity provider needs "issuer" and "jwksUri" in every environment`); }
      if (idn["provider"] === "pso-dev") for (const [n, e] of Object.entries(envs)) if (isObj(e) && e["kind"] === "production") err(`$.environments.${n}`, "PSO_INFRA_IDENTITY_DEV", `the pso-dev identity provider signs development tokens offline; it cannot serve the production environment "${n}"`, `Use "keycloak" with external TLS, or "external"`);
    }
  }
  const api = raw["api"];
  if (api !== undefined && (!isObj(api) || (api["host"] !== undefined && (typeof api["host"] !== "string" || !LABEL.test(api["host"]))))) err("$.api.host", "PSO_INFRA_HOST", `"api.host" must be a DNS label`);
  if (isObj(raw["frontends"])) for (const [n, f] of Object.entries(raw["frontends"])) {
    const p = `$.frontends.${n}`;
    if (!isObj(f)) { err(p, "PSO_INFRA_FRONTEND", "must be an object"); continue; }
    if (f["host"] !== undefined && (typeof f["host"] !== "string" || !LABEL.test(f["host"]))) err(`${p}.host`, "PSO_INFRA_HOST", `"host" must be a DNS label`);
    if (f["basePath"] !== undefined && (typeof f["basePath"] !== "string" || !/^\/([A-Za-z0-9._~-]+\/)*$/.test(f["basePath"]))) err(`${p}.basePath`, "PSO_INFRA_BASE_PATH", `"basePath" must be absolute and end with "/" (for example /admin/)`);
    if (f["auth"] !== undefined && !["oidc", "dev-token", "none"].includes(String(f["auth"]))) err(`${p}.auth`, "PSO_INFRA_FRONTEND_AUTH", `"auth" must be oidc, dev-token or none`);
    if (f["clientId"] !== undefined && (typeof f["clientId"] !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(f["clientId"]))) err(`${p}.clientId`, "PSO_INFRA_FRONTEND_CLIENT", `"clientId" must be a plain identifier`);
  }
  const lim = (p: string, r: unknown) => { if (r === undefined) return; if (!isObj(r)) { err(p, "PSO_INFRA_RESOURCES", "must be an object"); return; } if (r["memory"] !== undefined && (typeof r["memory"] !== "string" || !MEM.test(r["memory"]))) err(`${p}.memory`, "PSO_INFRA_RESOURCES", `"memory" must look like 512m or 1g`); if (r["cpus"] !== undefined && (typeof r["cpus"] !== "string" || !CPUS.test(r["cpus"]))) err(`${p}.cpus`, "PSO_INFRA_RESOURCES", `"cpus" must be a number as a string, such as "0.5"`); };
  if (isObj(raw["services"])) for (const [n, s] of Object.entries(raw["services"])) {
    if (!isObj(s)) { err(`$.services.${n}`, "PSO_INFRA_SERVICE", "must be an object"); continue; }
    if (s["mtls"] !== undefined && typeof s["mtls"] !== "boolean") err(`$.services.${n}.mtls`, "PSO_INFRA_SERVICE", `"mtls" must be true or false`);
    lim(`$.services.${n}.resources`, s["resources"]);
    if (s["secrets"] !== undefined && (!Array.isArray(s["secrets"]) || !(s["secrets"] as unknown[]).every((x) => typeof x === "string"))) err(`$.services.${n}.secrets`, "PSO_INFRA_SERVICE", `"secrets" must be a list of declared secret names`);
    serviceCommon(`$.services.${n}`, s, raw);
    if (s["volumes"] !== undefined) {
      if (!isObj(s["volumes"])) err(`$.services.${n}.volumes`, "PSO_INFRA_VOLUME", `"volumes" maps a volume name to an absolute path in the container`);
      else for (const [v, target] of Object.entries(s["volumes"])) {
        if (!KEBAB.test(v)) err(`$.services.${n}.volumes.${v}`, "PSO_INFRA_VOLUME", `volume name "${v}" must be kebab-case`);
        if (typeof target !== "string" || !VOLUME_TARGET.test(target) || target.split("/").includes("..")) err(`$.services.${n}.volumes.${v}`, "PSO_INFRA_VOLUME", `the mount point must be an absolute path inside the container`);
        else if (/^\/(run\/pso|run\/secrets|tmp)(\/|$)/.test(target) || target === "/") err(`$.services.${n}.volumes.${v}`, "PSO_INFRA_VOLUME", `${target} is managed by PSO (TLS material, secrets, temporary files): choose another path`);
      }
    }
    if (s["healthcheck"] !== undefined) {
      const h = s["healthcheck"];
      if (!isObj(h) || Object.keys(h).some((k) => k !== "startPeriod") || (h["startPeriod"] !== undefined && (typeof h["startPeriod"] !== "string" || !DURATION.test(h["startPeriod"])))) err(`$.services.${n}.healthcheck`, "PSO_INFRA_HEALTHCHECK", `"healthcheck" takes startPeriod, a duration such as "90s"`);
    }
  }
  const redis = raw["redis"];
  if (redis !== undefined) {
    if (!isObj(redis)) err("$.redis", "PSO_INFRA_REDIS", `"redis" must be an object: { "clients": ["<service>", ...] }`);
    else {
      const cl = redis["clients"];
      const names = Array.isArray(cl) ? cl : isObj(cl) ? Object.keys(cl) : undefined;
      if (!names || names.length === 0 || !names.every((x) => typeof x === "string" && KEBAB.test(x))) err("$.redis.clients", "PSO_INFRA_REDIS", `"redis.clients" names the services that use Redis (a list, or service -> variable names)`);
      if (isObj(cl)) for (const [svc, vars] of Object.entries(cl)) if (!Array.isArray(vars) || vars.length === 0 || !vars.every((v) => typeof v === "string" && VAR_NAME.test(v))) err(`$.redis.clients.${svc}`, "PSO_INFRA_REDIS", `the variables that receive the Redis address must be upper-case names, such as ["REDIS_URL"]`);
        else for (const v of vars as string[]) if (MANAGED_VARIABLES.test(v) || IDENTITY_VARIABLES.test(v)) err(`$.redis.clients.${svc}`, "PSO_INFRA_ENV_RESERVED", `${v} is managed by PSO and cannot receive the Redis address`);
      if (redis["persistence"] !== undefined && typeof redis["persistence"] !== "boolean") err("$.redis.persistence", "PSO_INFRA_REDIS", `"persistence" must be true or false`);
      lim("$.redis.resources", redis["resources"]);
      for (const k of Object.keys(redis)) if (!["clients", "persistence", "resources"].includes(k)) err(`$.redis.${k}`, "PSO_INFRA_REDIS", `unknown setting "${k}" (clients, persistence, resources)`);
    }
  }
  if (isObj(raw["secrets"])) for (const [n, s] of Object.entries(raw["secrets"])) {
    if (!KEBAB.test(n)) err(`$.secrets.${n}`, "PSO_INFRA_SECRET_NAME", `secret name "${n}" must be kebab-case`);
    if (!isObj(s)) { err(`$.secrets.${n}`, "PSO_INFRA_SECRET", "must be an object"); continue; }
    if (Object.keys(s).some((k) => /^(value|password|secret|key)$/i.test(k))) err(`$.secrets.${n}`, "PSO_INFRA_SECRET_IN_CONTRACT", `secret "${n}" carries a value: ${INFRA_FILE} only declares secrets, their values live in the environment's secret provider`);
    if (s["generate"] !== undefined && s["generate"] !== "random" && s["generate"] !== false) err(`$.secrets.${n}.generate`, "PSO_INFRA_SECRET", `"generate" must be "random" or false`);
  }
  const d = raw["docker"];
  if (d !== undefined) {
    if (!isObj(d)) err("$.docker", "PSO_INFRA_DOCKER", `"docker" must be an object`);
    else {
      if (d["project"] !== undefined && (typeof d["project"] !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(d["project"]))) err("$.docker.project", "PSO_INFRA_DOCKER", `"project" must be a Compose project name (lower-case letters, digits, - and _)`);
      const logs = d["logs"];
      if (logs !== undefined && (!isObj(logs) || (logs["maxSize"] !== undefined && (typeof logs["maxSize"] !== "string" || !SIZE.test(logs["maxSize"]))) || (logs["maxFile"] !== undefined && (!Number.isInteger(logs["maxFile"]) || (logs["maxFile"] as number) < 1)))) err("$.docker.logs", "PSO_INFRA_DOCKER", `"logs" takes maxSize (such as "10m") and maxFile (a positive integer)`);
      lim("$.docker.resources", d["resources"]);
    }
  }
  return out;
}

/** The environment to use: the flag, then PSO_INFRA_ENV, then the contract's default, then the only one declared. */
export function pickEnvironment(c: InfraContract, requested?: string): { name: string; env: EnvironmentDecl } {
  const name = requested ?? process.env["PSO_INFRA_ENV"] ?? c.defaultEnvironment ?? (Object.keys(c.environments).length === 1 ? Object.keys(c.environments)[0] : undefined);
  if (!name) throw new InfraError(`several environments are declared (${Object.keys(c.environments).join(", ")}): choose one with --env`, "PSO_INFRA_ENV_REQUIRED");
  const env = c.environments[name];
  if (!env) throw new InfraError(`unknown environment "${name}" (declared: ${Object.keys(c.environments).join(", ")})`, "PSO_INFRA_ENV_UNKNOWN");
  return { name, env };
}

/** Checks shared by `services.<name>` and `environments.<env>.services.<name>`: authentication, environment, replicas. */
function serviceCommon(p: string, s: Record<string, unknown>, raw: Record<string, unknown>): void {
  const issues = currentIssues!;
  const err = (path: string, code: string, message: string, hint?: string) => issues.push({ code, severity: "error", message, path, ...(hint ? { hint } : {}) });
  if (s["authentication"] !== undefined && s["authentication"] !== "infrastructure" && s["authentication"] !== "application") err(`${p}.authentication`, "PSO_INFRA_AUTHENTICATION", `"authentication" must be "infrastructure" (the environment's identity provider) or "application"`);
  if (s["replicas"] !== undefined && (!Number.isInteger(s["replicas"]) || (s["replicas"] as number) < 1 || (s["replicas"] as number) > 20)) err(`${p}.replicas`, "PSO_INFRA_REPLICAS", `"replicas" must be a whole number from 1 to 20`);
  const env = s["environment"];
  if (env === undefined) return;
  if (!isObj(env)) { err(`${p}.environment`, "PSO_INFRA_ENV_VARS", `"environment" maps variable names to values`); return; }
  for (const [k, v] of Object.entries(env)) {
    const at = `${p}.environment.${k}`;
    if (!VAR_NAME.test(k)) { err(at, "PSO_INFRA_ENV_VARS", `"${k}" is not a variable name (upper-case letters, digits and _)`); continue; }
    if (typeof v !== "string") { err(at, "PSO_INFRA_ENV_VARS", `the value of ${k} must be a string`); continue; }
    if (MANAGED_VARIABLES.test(k)) err(at, "PSO_INFRA_ENV_RESERVED", `${k} is set by PSO from the declarations and cannot be overridden here`);
    const ref = /^secret:\/\/(.+)$/.exec(v);
    if (ref) { if (!isObj(raw["secrets"]) || !Object.hasOwn(raw["secrets"], ref[1]!)) err(at, "PSO_INFRA_UNKNOWN_SECRET", `${k} references secret "${ref[1]}", which is not declared in "secrets"`); }
    else if (CREDENTIAL_NAME.test(k) && v !== "") err(at, "PSO_INFRA_SECRET_IN_CONTRACT", `${k} looks like a credential: declare a secret and write "secret://<name>" instead of its value`);
    else if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]{8,}\./.test(v) || /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/i.test(v)) err(at, "PSO_INFRA_SECRET_IN_CONTRACT", `the value of ${k} contains a credential: declare a secret and reference it`);
  }
}
let currentIssues: ContractIssue[] | undefined;

export class InfraError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(message: string, code = "PSO_INFRA_ERROR", hint?: string) { super(message); this.code = code; this.hint = hint; }
}

export const tlsSourceOf = (e: EnvironmentDecl): TlsSource => e.tls?.source ?? (e.kind === "development" ? "pso-dev-ca" : "external");
export const secretProviderOf = (e: EnvironmentDecl): SecretProvider => e.secrets?.provider ?? (e.kind === "development" ? "local" : "env");
export const runtimeOf = (e: EnvironmentDecl): RuntimeMode => e.runtime ?? "process";
