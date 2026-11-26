import { gzipDirectives, renderSiteLocations, securityHeaders } from "@pso/frontend/release";
import { INFRA_DIR, type InfraContract, type ResourceLimits } from "./contract.ts";
import { envVarOf, localSecretPath, secretRef } from "./secrets.ts";
import { managedIdentity, type ResolvedService, type Topology } from "./topology.ts";

/**
 * Every file the engine generates is rendered here, from the topology alone, deterministically: the same declarations always give the same
 * bytes (no timestamps, sorted keys), so "nothing changed" is detectable and a hand edit is detectable as drift.
 */
export const MANAGED_MARK = "Managed by PSO (pso infra:*).";
const header = (comment: string, what: string): string => [`${comment} ${MANAGED_MARK} Do not edit: change pso.workspace.json, pso.infra.json or the FEI/MEI declarations and run \`pso infra:apply\`.`, `${comment} ${what}`].join("\n");

/** Container names that the generated topology reserves. */
export const RESERVED_NAMES = ["edge", "idp", "idp-db", "redis"] as const;
export const CONTAINER_TLS = "/run/pso/tls";
export const CONTAINER_CLIENT_TLS = "/run/pso/client";

// ---------------------------------------------------------------------------------------------------------------------------------
// file layout of an environment (workspace-relative, forward slashes)

export const paths = {
  ca: (e: string) => `${INFRA_DIR}/ca/${e}`,
  certs: (e: string, n: string) => `${INFRA_DIR}/certs/${e}/${n}`,
  identity: (e: string) => `${INFRA_DIR}/identity/${e}`,
  nginx: (e: string, n: string) => `${INFRA_DIR}/nginx/${e}/${n}.conf`,
  site: (e: string, fei: string) => `${INFRA_DIR}/sites/${e}/${fei}`,
  compose: (e: string) => `${INFRA_DIR}/docker/${e}/compose.yml`,
  composeDeps: (e: string) => `${INFRA_DIR}/docker/${e}/compose.deps.yml`,
  hosts: (e: string) => `${INFRA_DIR}/hosts/${e}.hosts`,
  env: (e: string, s: string) => `${INFRA_DIR}/env/${e}/${s}.env`,
};

/** Where the TLS material of `name` is mounted from: PSO's store, or the operator's directory (external certificates). */
export function tlsSourceDir(t: Topology, name: string): string {
  return t.tlsSource === "pso-dev-ca" ? `./${paths.certs(t.env, name)}` : `${t.decl.tls!.dir!.replace(/\/+$/, "")}/${name}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// nginx

const upgradeMap = "map $http_upgrade $pso_connection_upgrade { default upgrade; '' close; }";
// the PUBLIC port the browser used (the edge listens on 8443 inside its container, the host may publish it as anything): an upstream that
// builds absolute URLs from forwarded headers (Keycloak) must see the public one
const proxyCommon = (verifyName: string, ws: boolean, publicPort: number): string[] => [
  "proxy_http_version 1.1;",
  "proxy_set_header Host $host;", "proxy_set_header X-Real-IP $remote_addr;", "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;", "proxy_set_header X-Forwarded-Proto https;", `proxy_set_header X-Forwarded-Host $host${publicPort === 443 ? "" : `:${publicPort}`};`, `proxy_set_header X-Forwarded-Port ${publicPort};`,
  ...(ws ? ["proxy_set_header Upgrade $http_upgrade;", "proxy_set_header Connection $pso_connection_upgrade;"] : ['proxy_set_header Connection "";']),
  // every hop behind the edge is TLS, verified against the environment's authority and the container's own name
  `proxy_ssl_trusted_certificate ${CONTAINER_TLS}/ca.crt;`, "proxy_ssl_verify on;", "proxy_ssl_verify_depth 2;", `proxy_ssl_name ${verifyName};`, "proxy_ssl_server_name on;",
  "proxy_connect_timeout 5s;", "proxy_read_timeout 120s;",
];
const tlsServer = (names: string[]): string[] => [
  "    listen 8443 ssl;", "    http2 on;", `    server_name ${names.join(" ")};`,
  `    ssl_certificate ${CONTAINER_TLS}/tls.crt;`, `    ssl_certificate_key ${CONTAINER_TLS}/tls.key;`,
  "    ssl_protocols TLSv1.2 TLSv1.3;", "    ssl_prefer_server_ciphers off;", "    ssl_session_cache shared:pso_tls:5m;",
];
const ind = (n: number, lines: string[]): string[] => lines.map((l) => `${" ".repeat(n)}${l}`);

/** The edge gateway: TLS termination and host routing for every FEI, the API and the identity provider. */
export function renderEdge(t: Topology): string {
  const orch = t.orchestrator;
  const out: string[] = [header("#", `Edge gateway of environment "${t.env}": ${t.publicHosts.join(", ")}`), "", upgradeMap, "server_tokens off;",
    // Docker's embedded DNS: upstream names are resolved per request, so a restarted container (new address) is found again without reloading
    "resolver 127.0.0.11 valid=10s ipv6=off;", "client_max_body_size 25m;", ""];
  const apiLocations = (prefix: string | null): string[] => !orch ? [] : [
    `    location ^~ ${prefix ?? "/"}${prefix ? "/" : ""} {`,
    `        set $pso_orchestrator https://${orch.name}:${orch.port};`,
    ...(prefix ? [`        rewrite ^${prefix}/(.*)$ /$1 break;`] : []),
    "        proxy_pass $pso_orchestrator;",
    ...ind(8, proxyCommon(orch.name, false, t.httpsPort)),
    "    }",
    ...(prefix ? [
      "    location = /channels {",
      `        set $pso_orchestrator https://${orch.name}:${orch.port};`,
      "        proxy_pass $pso_orchestrator;",
      ...ind(8, proxyCommon(orch.name, true, t.httpsPort)),
      "    }",
    ] : []),
  ];
  // the shell container is on the private edge network and serves public, immutable files only: no credential is sent to it
  const toFei = (loc: string, fei: string): string[] => [`    location ${loc} {`, `        set $pso_fei http://${fei}:8080;`, "        proxy_pass $pso_fei;", "        proxy_http_version 1.1;", "        proxy_set_header Host $host;", "        proxy_set_header X-Forwarded-Proto https;", '        proxy_set_header Connection "";', "    }"];
  // one server block per host: several shells may share a host under distinct base paths
  const hosts = [...new Set(t.frontends.map((f) => f.host))].sort();
  for (const host of hosts) {
    const fs = t.frontends.filter((f) => f.host === host).sort((a, b) => b.basePath.length - a.basePath.length);
    const apis = [...new Set(fs.map((f) => f.info.orchestratorBasePath.replace(/\/+$/, "") || "/api"))];
    out.push(`# ${fs.map((f) => `${f.name}: ${f.url}`).join("; ")}`, "server {", ...tlsServer([host]), ...securityHeaders(true, "    ").filter((l) => /Strict-Transport/.test(l)));
    apis.forEach((a, i) => out.push(...(i === 0 ? apiLocations(a) : apiLocations(a).slice(0, apiLocations(a).findIndex((l) => l.includes("location = /channels"))))));
    if (fs.length === 1) out.push(...toFei("/", fs[0]!.name));
    else {
      // released microfrontends live at /_mei/<name>/ of the host: each one is routed to the shell that mounts it
      for (const f of fs) for (const m of f.info.microfrontends) out.push(...toFei(`^~ /_mei/${m}/`, f.name));
      for (const f of fs) out.push(...toFei(f.basePath === "/" ? "/" : `^~ ${f.basePath.replace(/\/$/, "")}`, f.name));
    }
    out.push("}", "");
  }
  out.push(`# API: ${t.api.origin}`, "server {", ...tlsServer([t.api.host]), ...securityHeaders(true, "    ").filter((l) => /Strict-Transport|nosniff/.test(l)), ...apiLocations(null), "}", "");
  if (t.identity?.provider === "keycloak") {
    out.push(`# identity provider: ${t.identity.issuer}`, "server {", ...tlsServer([t.identity.host]), "    location / {", "        set $pso_idp https://idp:8443;", "        proxy_pass $pso_idp;", ...ind(8, proxyCommon("idp", false, t.httpsPort)), "        proxy_buffer_size 128k;", "        proxy_buffers 4 256k;", "    }", "}", "");
  } else if (t.identity?.provider === "pso-dev") {
    // the public keys live in the "idp" container (see renderIdpServer); the edge only publishes them under the identity's public host
    out.push(`# development identity: public keys only (tokens are signed offline by pso infra:token)`, "server {", ...tlsServer([t.identity.host]),
      "    location = /.well-known/jwks.json {", "        set $pso_idp https://idp:8443;", "        proxy_pass $pso_idp;", ...ind(8, proxyCommon("idp", false, t.httpsPort)), "    }",
      "    location / { return 404; }", "}", "");
  }
  out.push("# anything else is refused: a request for an unknown host never reaches an application", "server {", "    listen 8443 ssl default_server;", "    server_name _;", `    ssl_certificate ${CONTAINER_TLS}/tls.crt;`, `    ssl_certificate_key ${CONTAINER_TLS}/tls.key;`, "    return 421;", "}", "",
    "# container health (loopback only, never published)", "server {", "    listen 127.0.0.1:8081;", '    location = /health { access_log off; return 200 "ok"; }', "}", "");
  return out.join("\n");
}

/**
 * The key server of the pso-dev identity ("idp"): the public key set over TLS, nothing else. It has no dependency, so it is healthy before
 * any service starts; services reach it on the private network as https://idp:8443 and the edge publishes it under the identity's host.
 * The key set is mounted read-only from .infra/identity/<env>/jwks.json; the signing key never leaves the workspace.
 */
export function renderIdpServer(t: Topology): string {
  return [header("#", `Public keys of the pso-dev identity of environment "${t.env}" (${t.identity!.issuer}). Served to the services and the edge only.`), "server_tokens off;", "",
    "server {", "    listen 8443 ssl default_server;", "    server_name _;", `    ssl_certificate ${CONTAINER_TLS}/tls.crt;`, `    ssl_certificate_key ${CONTAINER_TLS}/tls.key;`, "    ssl_protocols TLSv1.2 TLSv1.3;",
    "    location = /.well-known/jwks.json {", "        alias /run/pso/identity/jwks.json;", "        default_type application/json;", '        add_header Cache-Control "no-store" always;', "    }",
    "    location / { return 404; }", "}", "",
    // healthy only while the key set is actually served (the health check reads it through this loopback server)
    "server {", "    listen 127.0.0.1:8081;", "    location = /health { access_log off; alias /run/pso/identity/jwks.json; default_type application/json; }", "}", ""].join("\n");
}

/** The static server of one FEI: its site root (shell releases, MEI releases, runtime configuration) with the framework's file rules. */
export function renderFeiServer(t: Topology, fei: string): string {
  const f = t.frontends.find((x) => x.name === fei)!;
  const connectSrc = t.identity?.provider === "keycloak" || t.identity?.provider === "external" ? [new URL(t.identity.tokenEndpoint || t.identity.issuer).origin] : [];
  const locs = renderSiteLocations({ site: "/srv/site", fei: { base: f.basePath, ...(f.info.routes.length ? { routes: f.info.routes } : {}) }, remotes: true, tls: true, ...(connectSrc.length ? { connectSrc } : {}) }, "    ");
  return [header("#", `Static server of ${fei} (${f.url}), environment "${t.env}". Served to the edge gateway only.`), "server_tokens off;", "",
    "server {", "    listen 8080;", "    server_name _;", ...gzipDirectives("    "), ...locs, "}", "",
    "server {", "    listen 127.0.0.1:8081;", '    location = /health { access_log off; return 200 "ok"; }', "}", ""].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// a tiny, deterministic YAML writer (enough for Compose). Every string is double-quoted; `$` is escaped so Compose never interpolates.

type Y = string | number | boolean | null | Y[] | { [k: string]: Y | undefined };
/** A value Compose must interpolate (only ${PSO_CONTAINER_USER:-default}); every other dollar sign is escaped. */
export const RAW = "\u0000raw:";
const q = (s: string): string => (s.startsWith(RAW) ? JSON.stringify(s.slice(RAW.length)) : JSON.stringify(s.replace(/\$/g, "$$$$")));
/**
 * The user a container runs as: its image's own unprivileged user by default; PSO_CONTAINER_USER (uid:gid) when the mounted keys and secret
 * files belong to another user, as operator-supplied material on a Linux host does (the remote deployment sets it to their owner, never root).
 */
const runAs = (def: string): string => `${RAW}\${PSO_CONTAINER_USER:-${def}}`;
function yaml(v: Y, indent = 0): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "object" && x !== null ? (() => { const inner = yaml(x, indent + 2); return [`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1)]; })() : [`${pad}- ${scalar(x)}`]));
  if (typeof v === "object" && v !== null) return Object.entries(v).filter(([, x]) => x !== undefined).flatMap(([k, x]) => {
    const key = /^[A-Za-z0-9_.-]+$/.test(k) ? k : JSON.stringify(k);
    if (typeof x === "object" && x !== null && (Array.isArray(x) ? x.length : Object.keys(x).length)) return [`${pad}${key}:`, ...yaml(x as Y, indent + 2)];
    if (typeof x === "object" && x !== null) return [`${pad}${key}: ${Array.isArray(x) ? "[]" : "{}"}`];
    return [`${pad}${key}: ${scalar(x as Y)}`];
  });
  return [`${pad}${scalar(v)}`];
}
const scalar = (v: Y): string => (typeof v === "string" ? q(v) : v === null ? "null" : String(v));

// ---------------------------------------------------------------------------------------------------------------------------------
// compose

const DEFAULT_LIMITS: Record<string, ResourceLimits> = { "spring-boot": { memory: "768m", cpus: "1.0" }, node: { memory: "384m", cpus: "1.0" }, nginx: { memory: "128m", cpus: "0.5" }, postgres: { memory: "512m", cpus: "1.0" }, keycloak: { memory: "1g", cpus: "1.5" }, redis: { memory: "256m", cpus: "0.5" } };
const up = (n: string) => n.toUpperCase().replace(/-/g, "_");
const dbName = (s: string) => s.replace(/-/g, "_");
const jwksTrusted = (issuer: string, jwks: string): string => { const a = new URL(issuer).hostname, b = new URL(jwks).hostname; return a === b ? "" : b; };

export interface ComposeSecret { name: string; target: string }
/**
 * The secrets one container receives as files under /run/secrets (never as variables in the compose file, never in an image): its database
 * password, the declared secrets it uses, the secret:// variables of the application and, for a Redis client, the Redis address.
 */
export function secretsOf(t: Topology, c: InfraContract, s: ResolvedService): ComposeSecret[] {
  const out = [...(s.db ? [{ name: `db-${s.name}`, target: "DB_PASSWORD" }] : []), ...(c.services?.[s.name]?.secrets ?? []).map((n) => ({ name: n, target: up(n) }))];
  for (const [k, v] of Object.entries(s.environment).sort(([a], [b]) => (a < b ? -1 : 1))) { const m = SECRET_VALUE.exec(v); if (m) out.push({ name: m[1]!, target: k }); }
  if (t.redis) for (const v of s.redisVariables) out.push({ name: "redis-url", target: v });
  return out;
}
const SECRET_VALUE = /^secret:\/\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
/** The address of the Redis container as a client container sees it; the password comes from the secret redis-password. */
export const redisContainerUrl = (password: string): string => `redis://default:${password}@redis:6379/0`;

export function renderCompose(t: Topology, c: InfraContract, mode: "stack" | "dependencies" = "stack"): string {
  const dev = t.kind === "development";
  const deps = mode === "dependencies";
  const services: Record<string, Y> = {};
  const secrets: Record<string, Y> = {};
  const volumes: Record<string, Y> = {};
  const lim = (kind: string, own?: ResourceLimits) => { const l = { ...DEFAULT_LIMITS[kind], ...(c.docker?.resources ?? {}), ...(own ?? {}) }; return { resources: { limits: { ...(l.memory ? { memory: l.memory } : {}), ...(l.cpus ? { cpus: l.cpus } : {}) } } }; };
  const logging = { driver: "json-file", options: { "max-size": t.logs.maxSize, "max-file": String(t.logs.maxFile) } };
  const hardening = { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] };
  const addSecret = (name: string) => {
    secrets[name] = t.secretProvider === "local" ? { file: `./${localSecretPath(t.env, name)}` } : t.secretProvider === "file" ? { file: `${t.decl.secrets!.dir!.replace(/\/+$/, "")}/${name}` } : { environment: envVarOf(name) };
  };
  const ca = t.tlsSource === "pso-dev-ca" ? `./${paths.ca(t.env)}/ca.crt` : `${t.decl.tls!.dir!.replace(/\/+$/, "")}/ca.crt`;
  const idp = t.identity;
  const jwtEnv = (s: ResolvedService): Record<string, string> => !idp || s.authentication === "application" ? {} : {
    PSO_JWT_ISSUER: idp.issuer, PSO_JWT_AUDIENCE: idp.audience, PSO_JWT_JWKS_URI: idp.jwksContainer, PSO_JWT_ALGORITHMS: idp.algorithms,
    // the keys are fetched from the provider's internal name, which differs from the issuer's public host: that binding is declared, never implied
    PSO_JWT_JWKS_TRUSTED_HOSTS: jwksTrusted(idp.issuer, idp.jwksContainer),
    PSO_JWT_JWKS_PRIVATE_HOSTS: idp.privateHostsContainer.join(","), PSO_JWT_JWKS_CA_FILE: idp.provider === "external" ? "" : `${CONTAINER_TLS}/ca.crt`,
    PSO_SECURITY_JWT_CA_FILE: idp.provider === "external" ? "" : `${CONTAINER_TLS}/ca.crt`, PSO_SECURITY_JWT_PRIVATE_HOSTS: idp.privateHostsContainer.join(","),
  };
  const psoEnv = t.kind === "development" ? "development" : t.kind;

  // databases: one per service that owns one, never shared, data in a named volume that survives `docker:down`
  for (const s of t.services.filter((x) => x.db)) {
    const n = `${s.name}-db`;
    addSecret(`db-${s.name}`);
    volumes[`${n}-data`] = {};
    services[n] = {
      image: t.images.postgres, restart: "unless-stopped",
      environment: { POSTGRES_DB: dbName(s.name), POSTGRES_USER: dbName(s.name), POSTGRES_PASSWORD_FILE: "/run/secrets/DB_PASSWORD" },
      secrets: [{ source: `db-${s.name}`, target: "DB_PASSWORD" }],
      volumes: [`${n}-data:/var/lib/postgresql/data`],
      healthcheck: { test: ["CMD-SHELL", `pg_isready -U ${dbName(s.name)} -d ${dbName(s.name)}`], interval: "5s", timeout: "3s", retries: 20 },
      networks: ["internal"], ...(deps ? { ports: [`127.0.0.1:${dbPort(t, s.name)}:5432`] } : {}),
      deploy: lim("postgres"), logging, security_opt: ["no-new-privileges:true"],
    };
  }
  if (idp?.provider === "keycloak") {
    addSecret("idp-admin");
    for (const u of idp.users) addSecret(`user-${u.username}`);
    if (dev) addSecret("idp-api-client");
    const exportLines = ["export KC_BOOTSTRAP_ADMIN_PASSWORD=\"$(cat /run/secrets/IDP_ADMIN)\"", ...idp.users.map((u) => `export PSO_USER_${up(u.username)}_PASSWORD="$(cat /run/secrets/USER_${up(u.username)})"`), ...(dev ? ["export PSO_API_CLIENT_SECRET=\"$(cat /run/secrets/IDP_API_CLIENT)\""] : [])];
    services["idp"] = {
      image: t.images.keycloak, restart: "unless-stopped", user: runAs("1000:0"),
      // the bootstrap password and the development users' passwords are read from secret files at start, so no value is ever in this file
      entrypoint: ["/bin/bash", "-c", `${exportLines.join("; ")}; exec /opt/keycloak/bin/kc.sh ${dev ? "start-dev" : "start"} --import-realm`],
      environment: {
        KC_BOOTSTRAP_ADMIN_USERNAME: "admin", KC_HOSTNAME: `https://${idp.host}${t.httpsPort === 443 ? "" : `:${t.httpsPort}`}`, KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true",
        KC_HTTP_ENABLED: "false", KC_HTTPS_PORT: "8443", KC_HTTPS_CERTIFICATE_FILE: `${CONTAINER_TLS}/tls.crt`, KC_HTTPS_CERTIFICATE_KEY_FILE: `${CONTAINER_TLS}/tls.key`,
        KC_HEALTH_ENABLED: "true", KC_PROXY_HEADERS: "xforwarded",
      },
      secrets: [{ source: "idp-admin", target: "IDP_ADMIN" }, ...idp.users.map((u) => ({ source: `user-${u.username}`, target: `USER_${up(u.username)}` })), ...(dev ? [{ source: "idp-api-client", target: "IDP_API_CLIENT" }] : [])],
      volumes: [`./${paths.identity(t.env)}/realm.json:/opt/keycloak/data/import/realm.json:ro`, `${tlsSourceDir(t, "idp")}:${CONTAINER_TLS}:ro`],
      healthcheck: { test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && echo ok"], interval: "5s", timeout: "3s", retries: 60, start_period: "20s" },
      networks: { internal: {}, ...(deps ? {} : { edge: {} }) }, ...(deps ? { ports: [`127.0.0.1:${t.httpsPort}:8443`] } : {}),
      deploy: lim("keycloak"), logging, security_opt: ["no-new-privileges:true"],
    };
  }
  if (idp?.provider === "pso-dev") {
    services["idp"] = {
      image: t.images.nginx, restart: "unless-stopped", user: runAs("101:101"),
      volumes: [`./${paths.nginx(t.env, "idp")}:/etc/nginx/conf.d/default.conf:ro`, `${tlsSourceDir(t, "idp")}:${CONTAINER_TLS}:ro`, `./${paths.identity(t.env)}/jwks.json:/run/pso/identity/jwks.json:ro`],
      tmpfs: ["/var/cache/nginx:mode=1777", "/var/run:mode=1777", "/tmp:mode=1777"],
      healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8081/health | grep -q keys || exit 1"], interval: "5s", timeout: "3s", retries: 12 },
      networks: { internal: {}, ...(deps ? {} : { edge: {} }) }, ...(deps ? { ports: [`127.0.0.1:${t.httpsPort}:8443`] } : {}),
      deploy: lim("nginx"), logging, ...hardening,
    };
  }
  if (t.redis?.provider === "container") {
    addSecret("redis-password");
    if (t.redis.persistence) volumes["redis-data"] = {};
    // the password is read from its secret file at start and handed to redis-server on standard input: it is never in this file, in
    // the container's command line or in its environment
    const conf = ["bind 0.0.0.0", "port 6379", "protected-mode yes", "requirepass $(cat /run/secrets/REDIS_PASSWORD)", ...(t.redis.persistence ? ["appendonly yes", "dir /data"] : ["appendonly no", "save \"\""])];
    services["redis"] = {
      image: t.images.redis, restart: "unless-stopped", user: runAs("999:1000"),
      // the configuration (with the password) is written to the container's memory-only /tmp, readable by its user only
      entrypoint: ["/bin/sh", "-c", `set -eu; umask 077; printf '%s\\n' ${conf.map((l) => `"${l.replace(/"/g, '\\"')}"`).join(" ")} > /tmp/redis.conf; exec redis-server /tmp/redis.conf`],
      secrets: [{ source: "redis-password", target: "REDIS_PASSWORD" }],
      ...(t.redis.persistence ? { volumes: ["redis-data:/data"] } : {}), tmpfs: ["/tmp"],
      healthcheck: { test: ["CMD-SHELL", "REDISCLI_AUTH=\"$(cat /run/secrets/REDIS_PASSWORD)\" redis-cli -p 6379 ping | grep -q PONG"], interval: "5s", timeout: "3s", retries: 20 },
      networks: ["internal"], ...(deps ? { ports: [`127.0.0.1:${t.redis.port}:6379`] } : {}),
      deploy: lim("redis", t.redis.resources), logging, ...hardening,
    };
  }
  if (!deps) {
    for (const s of t.services) {
      const isOrch = s.role === "orchestrator";
      const env: Record<string, string> = { PSO_ENV: psoEnv, PORT: String(s.port), HOST: "0.0.0.0", ...jwtEnv(s) };
      // the application's own plain variables; secret:// values become mounted files (below)
      for (const [k, v] of Object.entries(s.environment).sort(([a], [b]) => (a < b ? -1 : 1))) if (!SECRET_VALUE.test(v)) env[k] = v;
      const vols = [`${tlsSourceDir(t, s.name)}:${CONTAINER_TLS}:ro`];
      if (isOrch) {
        Object.assign(env, { PSO_HTTP_TLS_CERT_FILE: `${CONTAINER_TLS}/tls.crt`, PSO_HTTP_TLS_KEY_FILE: `${CONTAINER_TLS}/tls.key`, PSO_SHUTDOWN_GRACE_MS: "5000" });
        for (const u of t.services.filter((x) => x.role !== "orchestrator")) {
          env[`PSO_UPSTREAM_${up(u.name)}`] = `${u.name}:${u.port}`;
          if (u.prefix) env[`PSO_UPSTREAM_${up(u.name)}_PREFIX`] = u.prefix;
          env[`PSO_UPSTREAM_${up(u.name)}_TLS`] = "true";
          env[`PSO_UPSTREAM_${up(u.name)}_TLS_CA_FILE`] = `${CONTAINER_TLS}/ca.crt`;
          if (u.mtls) { env[`PSO_UPSTREAM_${up(u.name)}_TLS_CERT_FILE`] = `${CONTAINER_CLIENT_TLS}/tls.crt`; env[`PSO_UPSTREAM_${up(u.name)}_TLS_KEY_FILE`] = `${CONTAINER_CLIENT_TLS}/tls.key`; }
        }
        if (t.services.some((x) => x.mtls)) vols.push(`${tlsSourceDir(t, `${s.name}-client`)}:${CONTAINER_CLIENT_TLS}:ro`);
      } else {
        Object.assign(env, { SERVER_SSL_CERTIFICATE: `file:${CONTAINER_TLS}/tls.crt`, SERVER_SSL_CERTIFICATE_PRIVATE_KEY: `file:${CONTAINER_TLS}/tls.key`, SPRING_PROFILES_ACTIVE: dev ? "local" : "prod" });
        // mutual TLS: the service accepts only clients with a certificate issued by the environment's authority (the orchestrator's)
        if (s.mtls) Object.assign(env, { SERVER_SSL_CLIENT_AUTH: "need", SERVER_SSL_TRUST_CERTIFICATE: `file:${CONTAINER_TLS}/ca.crt` });
        if (s.db) Object.assign(env, { DB_URL: `jdbc:postgresql://${s.name}-db:5432/${dbName(s.name)}`, DB_USER: dbName(s.name) });
      }
      const sec = secretsOf(t, c, s);
      for (const x of sec) addSecret(x.name);
      // Spring reads the mounted secret files as configuration properties (configtree): the value never becomes an environment variable.
      // A Node service reads the files it is told about into its own variables when it starts (PSO_SECRET_FILES, @pso/http).
      if (sec.length && s.runtime === "spring-boot") env["SPRING_CONFIG_IMPORT"] = "optional:configtree:/run/secrets/";
      if (sec.length && s.runtime === "node") env["PSO_SECRET_FILES"] = [...new Set(sec.map((x) => x.target))].sort().join(",");
      const healthPath = s.decl.health ?? (isOrch ? "/health/ready" : "/actuator/health");
      const health = isOrch || s.runtime === "node"
        ? ["CMD", "node", "-e", `require('https').get({host:'127.0.0.1',port:${s.port},path:'${healthPath}',ca:require('fs').readFileSync('${CONTAINER_TLS}/ca.crt'),servername:'${s.name}'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))`]
        : ["CMD-SHELL", `curl -fsS --cacert ${CONTAINER_TLS}/ca.crt ${s.mtls ? `--cert ${CONTAINER_TLS}/tls.crt --key ${CONTAINER_TLS}/tls.key ` : ""}--resolve ${s.name}:${s.port}:127.0.0.1 https://${s.name}:${s.port}${healthPath} >/dev/null || exit 1`];
      const dependsOn: Record<string, Y> = {};
      for (const d of s.dependsOn) dependsOn[d] = { condition: "service_healthy" };
      if (s.db) dependsOn[`${s.name}-db`] = { condition: "service_healthy" };
      if (isOrch) for (const u of t.services.filter((x) => x.role !== "orchestrator")) dependsOn[u.name] = { condition: "service_healthy" };
      // the key server needs nothing to start; a service that validates tokens itself (authentication "application") does not wait for it
      if (managedIdentity(t) && s.authentication === "infrastructure") dependsOn["idp"] = { condition: "service_healthy" };
      if (t.redis?.provider === "container" && s.redisVariables.length) dependsOn["redis"] = { condition: "service_healthy" };
      const named = Object.entries(s.volumes).sort(([a], [b]) => (a < b ? -1 : 1));
      for (const [v] of named) volumes[`${s.name}-${v}`] = {};
      vols.push(...named.map(([v, target]) => `${s.name}-${v}:${target}`));
      services[s.name] = {
        build: { context: `./${s.decl.path}` }, image: `${t.project}-${s.name}:${t.env}`, restart: "unless-stopped",
        user: runAs(isOrch || s.runtime === "node" ? "1000:1000" : "10001:10001"),
        environment: env,
        ...(sec.length ? { secrets: sec.map((x) => ({ source: x.name, target: x.target })) } : {}),
        volumes: vols, tmpfs: ["/tmp"], healthcheck: { test: health, interval: "10s", timeout: "5s", retries: 12, start_period: s.startPeriod ?? (s.runtime === "spring-boot" ? "60s" : "15s") },
        ...(Object.keys(dependsOn).length ? { depends_on: dependsOn } : {}),
        networks: isOrch ? ["internal", "edge"] : ["internal"],
        ...(dev && t.decl.publishServices === true ? { ports: [`127.0.0.1:${s.port}:${s.port}`] } : {}),
        stop_grace_period: "40s", deploy: { ...(s.replicas > 1 ? { replicas: s.replicas } : {}), ...lim(s.runtime, c.services?.[s.name]?.resources) }, logging, ...hardening,
      };
    }
    for (const f of t.frontends) {
      services[f.name] = {
        image: t.images.nginx, restart: "unless-stopped", user: runAs("101:101"),
        // the site root is mounted read-only: publishing a release (pso frontend:publish) changes what is served without touching the container.
        // The active shell is named by fei/current.json (the release engine's pointer); the container follows it itself, so the result is the
        // same whether the host could create the POSIX `fei/current` symlink or not (Windows)
        volumes: [`./${paths.nginx(t.env, f.name)}:/etc/nginx/conf.d/default.conf:ro`, `./${paths.site(t.env, f.name)}:/srv/site-src:ro`],
        tmpfs: ["/var/cache/nginx:mode=1777", "/var/run:mode=1777", "/tmp:mode=1777", "/srv/site:mode=1777"],
        entrypoint: ["/bin/sh", "-c", FEI_ENTRYPOINT],
        healthcheck: { test: ["CMD-SHELL", "test -e /srv/site/fei/current/index.html && wget -qO- http://127.0.0.1:8081/health >/dev/null || exit 1"], interval: "5s", timeout: "3s", retries: 12 },
        networks: ["edge"], deploy: lim("nginx"), logging, ...hardening,
      };
    }
    const edgeDeps: Record<string, Y> = {};
    for (const f of t.frontends) edgeDeps[f.name] = { condition: "service_healthy" };
    if (t.orchestrator) edgeDeps[t.orchestrator.name] = { condition: "service_healthy" };
    if (managedIdentity(t)) edgeDeps["idp"] = { condition: "service_healthy" };
    services["edge"] = {
      image: t.images.nginx, restart: "unless-stopped", user: runAs("101:101"),
      volumes: [`./${paths.nginx(t.env, "edge")}:/etc/nginx/conf.d/default.conf:ro`, `${tlsSourceDir(t, "edge")}:${CONTAINER_TLS}:ro`],
      tmpfs: ["/var/cache/nginx:mode=1777", "/var/run:mode=1777", "/tmp:mode=1777"],
      ports: [dev ? `127.0.0.1:${t.httpsPort}:8443` : `${t.httpsPort}:8443`],
      healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8081/health >/dev/null || exit 1"], interval: "5s", timeout: "3s", retries: 12 },
      ...(Object.keys(edgeDeps).length ? { depends_on: edgeDeps } : {}),
      networks: { edge: { aliases: ["edge"] } }, deploy: lim("nginx"), logging, ...hardening,
    };
  }
  const doc: Record<string, Y> = {
    name: deps ? `${t.project}-deps` : t.project,
    services,
    networks: { internal: { driver: "bridge", internal: !dev }, ...(deps ? {} : { edge: { driver: "bridge" } }) },
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
  return [header("#", deps
    ? `Infrastructure dependencies of environment "${t.env}" (databases, identity provider) for \`pso dev --with-dependencies\`: published on loopback only.`
    : `Container topology of environment "${t.env}". Start with \`pso docker:up --env ${t.env}\`; persistent data lives in named volumes that \`pso docker:down\` keeps.`),
  "# Secrets are mounted files (see `secrets:`); no secret value is written in this file or baked into an image.", ...yaml(doc), ""].join("\n");
}

/**
 * Start script of a FEI container: a read-only view of the published site under /srv/site whose `fei/current` follows fei/current.json
 * (checked every 2 s; the switch is one symlink rename). Until a shell release is published the container is up but not healthy.
 */
export const FEI_ENTRYPOINT = [
  "set -eu", "S=/srv/site-src; D=/srv/site", "mkdir -p $D/fei",
  "ln -sfn $S/_mei $D/_mei; ln -sfn $S/pso-runtime-config.json $D/pso-runtime-config.json; ln -sfn $S/fei/assets $D/fei/assets",
  `follow() { v=$(sed -n 's/.*"version"[^"]*"\\([^"]*\\)".*/\\1/p' $S/fei/current.json 2>/dev/null || true); if [ -n "$v" ] && [ -d "$S/fei/$v" ] && [ "$(readlink $D/fei/current 2>/dev/null || true)" != "$S/fei/$v" ]; then ln -sfn "$S/fei/$v" $D/fei/.current && mv -Tf $D/fei/.current $D/fei/current; fi; }`,
  "follow", "(while true; do sleep 2; follow; done) &", "exec nginx -g 'daemon off;'",
].join("\n");

/** Host port of a service's database in the dependencies stack (process mode): 5432, 5433, ... in workspace order. */
export function dbPort(t: Topology, service: string): number { return 5432 + t.services.filter((s) => s.db).findIndex((s) => s.name === service); }

// ---------------------------------------------------------------------------------------------------------------------------------
// identity provider

export function renderRealm(t: Topology): string {
  const idp = t.identity!;
  const dev = t.kind === "development";
  const mappers = [
    { name: "pso audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: { "included.custom.audience": idp.audience, "id.token.claim": "false", "access.token.claim": "true" } },
    { name: "pso scopes", protocol: "openid-connect", protocolMapper: "oidc-usermodel-realm-role-mapper", config: { "claim.name": "scp", multivalued: "true", "jsonType.label": "String", "id.token.claim": "false", "access.token.claim": "true", "userinfo.token.claim": "false" } },
  ];
  const clients = t.frontends.filter((f) => f.auth === "oidc").map((f) => ({
    clientId: f.clientId, name: `${f.name} (PSO FEI)`, enabled: true, publicClient: true, standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: false, fullScopeAllowed: true,
    redirectUris: f.redirectUris, webOrigins: f.webOrigins, attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": f.postLogoutRedirectUris.join("##"), "pso.managed": "true" }, protocolMappers: mappers,
  }));
  // development only: a confidential client for request tools (Studio API Client): client credentials and the resource owner grant
  if (dev) clients.push({ clientId: "pso-api-client", name: "PSO development API client (Studio)", enabled: true, publicClient: false, secret: "${PSO_API_CLIENT_SECRET}", standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: true, serviceAccountsEnabled: true, fullScopeAllowed: true, redirectUris: [], webOrigins: [], attributes: { "pso.managed": "true" }, protocolMappers: mappers } as never);
  const realm = {
    realm: idp.realm, enabled: true, sslRequired: "external", registrationAllowed: false, loginWithEmailAllowed: true, bruteForceProtected: true,
    accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, revokeRefreshToken: true, refreshTokenMaxReuse: 0,
    roles: { realm: idp.scopes.map((s) => ({ name: s, attributes: { "pso.managed": ["true"] } })) },
    clients,
    users: idp.users.map((u) => ({ username: u.username, enabled: true, email: u.email ?? `${u.username}@${idp.realm}.test`, emailVerified: true, firstName: u.username, lastName: "Development", realmRoles: u.scopes, credentials: [{ type: "password", value: `\${PSO_USER_${up(u.username)}_PASSWORD}`, temporary: false }] })),
  };
  // no comment member: Keycloak's importer rejects unknown properties. Ownership is recorded in .infra/state.json (hash of this file)
  return JSON.stringify(realm, null, 2) + "\n";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// hosts and process environments

export const hostsMarker = (ws: string, env: string) => ({ begin: `# BEGIN PSO ${ws}/${env}`, end: `# END PSO ${ws}/${env}` });
export function renderHosts(t: Topology, ws: string): string {
  const m = hostsMarker(ws, t.env);
  return [m.begin, `# ${MANAGED_MARK} Proposed local name resolution for environment "${t.env}". Applied to the system hosts file only by \`pso infra:hosts --apply --yes\`.`, `127.0.0.1 ${t.publicHosts.join(" ")}`, m.end, ""].join("\n");
}

/** Environment of a service started as a local process (`pso dev`) against this environment's dependencies. Secrets stay references. */
export function renderProcessEnv(t: Topology, c: InfraContract, s: ResolvedService): string {
  const idp = t.identity;
  const lines: string[] = [header("#", `Environment of ${s.name} as a local process in "${t.env}". Values secret://<name> (and \${secret://<name>} inside a value) are resolved by \`pso dev\` when it starts the process.`)];
  if (idp && s.authentication === "application") lines.push(`# authentication: configured by the application (pso.infra.json services.${s.name}.authentication); no identity setting is given here`);
  if (idp && s.authentication === "infrastructure") lines.push(`PSO_JWT_ISSUER=${idp.issuer}`, `PSO_JWT_AUDIENCE=${idp.audience}`, `PSO_JWT_JWKS_URI=${idp.jwksHost}`, `PSO_JWT_ALGORITHMS=${idp.algorithms}`,
    ...(jwksTrusted(idp.issuer, idp.jwksHost) ? [`PSO_JWT_JWKS_TRUSTED_HOSTS=${jwksTrusted(idp.issuer, idp.jwksHost)}`] : []),
    ...(idp.privateHostsHost.length ? [`PSO_JWT_JWKS_PRIVATE_HOSTS=${idp.privateHostsHost.join(",")}`, `PSO_SECURITY_JWT_PRIVATE_HOSTS=${idp.privateHostsHost.join(",")}`] : []),
    ...(idp.provider !== "external" && t.tlsSource === "pso-dev-ca" ? [`PSO_JWT_JWKS_CA_FILE=${paths.ca(t.env)}/ca.crt`, `PSO_SECURITY_JWT_CA_FILE=${paths.ca(t.env)}/ca.crt`] : []));
  if (s.db) lines.push(`DB_URL=jdbc:postgresql://127.0.0.1:${dbPort(t, s.name)}/${dbName(s.name)}`, `DB_USER=${dbName(s.name)}`, `DB_PASSWORD=${secretRef(`db-${s.name}`)}`);
  for (const n of c.services?.[s.name]?.secrets ?? []) lines.push(`${up(n)}=${secretRef(n)}`);
  if (t.redis) for (const v of s.redisVariables) lines.push(`${v}=${t.redis.provider === "container" ? `redis://default:\${${secretRef("redis-password")}}@127.0.0.1:${t.redis.port}/0` : secretRef("redis-url")}`);
  for (const [k, v] of Object.entries(s.environment).sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${k}=${v}`);
  return lines.join("\n") + "\n";
}
