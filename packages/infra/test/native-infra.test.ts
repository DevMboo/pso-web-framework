// Regression tests of the native container infrastructure (0.2.0-rc.7): D2 (edge <-> gateway start-up cycle with the pso-dev identity),
// D3 (Redis and application settings), D4 (services could not reach the key set) and D5 (process mode mixed the infrastructure's key
// source with the application's). The compose checks run against the effective model of the real Docker Compose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, containerGraph, dependencyCycle, mergeProcessEnvironment, plan, processEnvironment, resolveTopology, startupOrder, validateContract, InfraError, type EngineHooks, type FrontendInfo } from "../src/index.ts";
import { loadSecurityConfig } from "../../security/src/index.ts";

const fei = (name: string, port: number): FrontendInfo => ({ name, port, authentication: "jwt", microfrontends: [], scopes: [], orchestratorBasePath: "/api", routes: [] });
function workspace(infra: unknown) {
  const root = mkdtempSync(join(tmpdir(), "pso-native-"));
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "shop", services: [
    { name: "gateway", path: "gateway", runtime: "node", role: "orchestrator", port: 3000, health: "/health/ready" },
    { name: "catalog", path: "catalog", runtime: "spring-boot", role: "service", port: 8081, db: "postgres", prefix: "/catalog", health: "/actuator/health" },
  ] }, null, 2));
  for (const d of ["gateway", "catalog"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "pso.infra.json"), JSON.stringify(infra, null, 2));
  const hooks: EngineHooks = { frontends: () => ({ frontends: [fei("fei-shop", 4200), fei("fei-admin", 4300)], scopes: [] }) };
  return { root, hooks };
}
const env = (o: Record<string, unknown> = {}) => ({ kind: "development", domain: "pso.localhost", runtime: "docker", httpsPort: 8443, ...o });
const PSO_DEV = { schemaVersion: 1, defaultEnvironment: "local", environments: { local: env() }, identity: { provider: "pso-dev", users: [{ username: "ana", scopes: ["*"] }] } };
const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split("/")), "utf8");
const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const skipNoCompose = { skip: hasCompose ? false : "docker compose is not available" };

interface Model { services: Record<string, { depends_on?: Record<string, unknown>; networks?: Record<string, unknown> | string[]; environment?: Record<string, string>; secrets?: Array<{ source: string; target: string }>; ports?: unknown[]; volumes?: Array<{ source?: string; target?: string; type?: string }>; healthcheck?: { test?: string[]; start_period?: string }; deploy?: { replicas?: number } }>; volumes?: Record<string, unknown> }
function composeModel(root: string, file = "compose.yml"): Model {
  const f = join(root, ".infra", "docker", "local", file);
  const r = spawnSync("docker", ["compose", "-f", f, "--project-directory", root, "config", "--format", "json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Model;
}
const nets = (s: Model["services"][string]): string[] => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}));

/**
 * What a working container topology needs for token validation, checked on the EFFECTIVE compose model: every key set URL names a
 * container that exists, shares a network with the service that fetches it, and does not wait (transitively) for that service; and the
 * start-up graph has no cycle. Returns the problems found (empty: the topology starts and authenticates).
 */
function keyReachability(m: Model): string[] {
  const problems: string[] = [];
  const graph = Object.fromEntries(Object.entries(m.services).map(([n, s]) => [n, Object.keys(s.depends_on ?? {})]));
  const cycle = dependencyCycle(graph);
  if (cycle) problems.push(`start-up cycle: ${cycle.join(" -> ")}`);
  const needs = (from: string, to: string, seen = new Set<string>()): boolean => { if (from === to) return true; if (seen.has(from)) return false; seen.add(from); return (graph[from] ?? []).some((d) => needs(d, to, seen)); };
  for (const [name, s] of Object.entries(m.services)) {
    const jwks = s.environment?.["PSO_JWT_JWKS_URI"];
    if (!jwks) continue;
    const host = new URL(jwks).hostname;
    const target = m.services[host];
    if (!target) { problems.push(`${name}: ${jwks} names no container`); continue; }
    if (!nets(s).some((n) => nets(target).includes(n))) problems.push(`${name}: ${host} is not on any of its networks (${nets(s).join(", ")})`);
    if (needs(host, name)) problems.push(`${name}: its key server ${host} waits for it`);
  }
  return problems;
}

test("D2/D4: the checker rejects the 0.2.0-rc.6 topology (edge serves the keys, waits for the gateway; catalog cannot resolve the edge)", () => {
  // the shape rc.5 and rc.6 generate for a pso-dev identity (docker compose config of a real rc.6 workspace, reduced to what matters)
  const rc6: Model = { services: {
    edge: { depends_on: { gateway: {}, "fei-shop": {} }, networks: ["edge"] },
    gateway: { depends_on: { catalog: {} }, networks: ["internal", "edge"], environment: { PSO_JWT_JWKS_URI: "https://edge:8443/.well-known/jwks.json" } },
    catalog: { depends_on: { "catalog-db": {} }, networks: ["internal"], environment: { PSO_JWT_JWKS_URI: "https://edge:8443/.well-known/jwks.json" } },
    "catalog-db": { networks: ["internal"] }, "fei-shop": { networks: ["edge"] },
  } };
  const p = keyReachability(rc6);
  assert.ok(p.some((x) => /gateway: its key server edge waits for it/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /catalog: edge is not on any of its networks/.test(x)), p.join("\n"));
});

test("D2/D4: with the pso-dev identity the keys come from their own container, reachable by every service, with no start-up cycle", skipNoCompose, () => {
  const { root, hooks } = workspace(PSO_DEV);
  apply(root, { hooks });
  const m = composeModel(root);
  assert.deepEqual(keyReachability(m), []);
  const idp = m.services["idp"]!;
  assert.deepEqual(nets(idp).sort(), ["edge", "internal"].map((n) => n).sort().map((n) => n), "the key server is on the private network (services) and the edge network (published keys)");
  assert.deepEqual(Object.keys(idp.depends_on ?? {}), [], "the key server needs nothing to start");
  assert.equal(idp.ports, undefined, "never published by the stack: the edge is the only public entry");
  for (const s of ["gateway", "catalog", "edge"]) assert.ok(m.services[s]!.depends_on?.["idp"], `${s} waits for the key server`);
  assert.equal(m.services["catalog"]!.environment!["PSO_JWT_JWKS_URI"], "https://idp:8443/.well-known/jwks.json");
  assert.equal(m.services["catalog"]!.environment!["PSO_SECURITY_JWT_PRIVATE_HOSTS"], "idp:8443");
  assert.equal(m.services["gateway"]!.environment!["PSO_JWT_JWKS_TRUSTED_HOSTS"], "idp", "the key host differs from the issuer's: the binding is declared");
  // TLS everywhere: the key server presents a certificate of the environment's authority that names it
  const cert = plan(root, undefined, hooks).resources.find((r) => r.id === "cert:idp")!;
  assert.equal(cert.status, "ok");
  assert.match(String(cert.facts["names"]), /(^|,)idp(,|$)/);
  // the edge no longer holds the key set itself; it forwards the identity's public host to the key server
  const edge = read(root, ".infra/nginx/local/edge.conf");
  assert.doesNotMatch(edge, /alias \/run\/pso\/identity/);
  assert.match(edge, /set \$pso_idp https:\/\/idp:8443;[\s\S]*proxy_ssl_name idp;/);
  assert.match(read(root, ".infra/nginx/local/idp.conf"), /location = \/\.well-known\/jwks\.json \{\s+alias \/run\/pso\/identity\/jwks\.json;/);
  // the start order the CLI prints is the compose order, and it starts the key server first
  const order = startupOrder(plan(root, undefined, hooks).topology);
  assert.ok(order.indexOf("idp") < order.indexOf("gateway") && order.indexOf("gateway") < order.indexOf("edge"), order.join(" -> "));
  // process mode: `pso dev --with-dependencies` runs the key server on loopback, where the processes' JWKS address points
  const deps = composeModel(root, "compose.deps.yml");
  assert.ok(deps.services["idp"], "the dependencies stack carries the key server");
  assert.match(JSON.stringify(deps.services["idp"]!.ports), /"host_ip":"127\.0\.0\.1".*"published":"8443"/);
  assert.match(read(root, ".infra/env/local/gateway.env"), /^PSO_JWT_JWKS_URI=https:\/\/127\.0\.0\.1:8443\/\.well-known\/jwks\.json$/m);
});

test("D2/D4: the Keycloak topology still passes the same checks", skipNoCompose, () => {
  const { root, hooks } = workspace({ ...PSO_DEV, identity: { provider: "keycloak", realm: "shop", users: [{ username: "ana", scopes: ["*"] }] } });
  apply(root, { hooks });
  assert.deepEqual(keyReachability(composeModel(root)), []);
});

test("the nginx configuration of the key server is accepted by the real nginx", { skip: spawnSync("docker", ["image", "inspect", "nginx:1.27-alpine"], { encoding: "utf8" }).status !== 0 ? "image nginx:1.27-alpine is not available" : false }, () => {
  const { root, hooks } = workspace(PSO_DEV);
  apply(root, { hooks });
  const d = join(root, ".infra");
  // nginx -t needs the files it names: the certificate pair of the key server and the key set
  const r = spawnSync("docker", ["run", "--rm", "-v", `${join(d, "nginx", "local", "idp.conf")}:/etc/nginx/conf.d/default.conf:ro`, "-v", `${join(d, "certs", "local", "idp")}:/run/pso/tls:ro`, "-v", `${join(d, "identity", "local", "jwks.json")}:/run/pso/identity/jwks.json:ro`, "nginx:1.27-alpine", "nginx", "-t"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("D3: Redis is provisioned only where it is declared: private network, password, persistent volume, health check, clients wired", skipNoCompose, () => {
  const declared = { ...PSO_DEV, redis: { clients: { gateway: ["REDIS_URL", "PSO_CHANNELS_REDIS_URL"], catalog: ["REDIS_URL"] } } };
  const { root, hooks } = workspace(declared);
  apply(root, { hooks });
  const m = composeModel(root);
  const redis = m.services["redis"]!;
  assert.deepEqual(nets(redis), ["internal"], "Redis is on the private network only");
  assert.equal(redis.ports, undefined, "never published by the stack");
  assert.deepEqual(redis.secrets?.map((x) => x.target), ["REDIS_PASSWORD"]);
  assert.ok(redis.volumes?.some((v) => v.source === "redis-data" && v.target === "/data"), "data in a named volume (kept by docker:down)");
  assert.ok(m.volumes?.["redis-data"]);
  assert.match(JSON.stringify(redis.healthcheck?.test), /redis-cli -p 6379 ping/);
  const pw = read(root, ".infra/secrets/local/redis-password").trim();
  assert.equal(read(root, ".infra/secrets/local/redis-url").trim(), `redis://default:${pw}@redis:6379/0`, "the clients' address is derived from the password");
  assert.ok(!JSON.stringify(m).includes(pw), "the password is in no generated file and no effective compose value");
  // clients: the address as a secret file in the variables they name, and they wait for Redis
  const gw = m.services["gateway"]!, cat = m.services["catalog"]!;
  assert.deepEqual(gw.secrets?.filter((x) => x.source === "redis-url").map((x) => x.target).sort(), ["PSO_CHANNELS_REDIS_URL", "REDIS_URL"]);
  assert.equal(gw.environment!["PSO_SECRET_FILES"], "PSO_CHANNELS_REDIS_URL,REDIS_URL", "a Node service reads its secret files into these variables");
  assert.equal(cat.environment!["SPRING_CONFIG_IMPORT"], "optional:configtree:/run/secrets/", "Spring reads them as properties");
  for (const s of [gw, cat]) assert.ok(s.depends_on?.["redis"]);
  assert.deepEqual(keyReachability(m), []);
  // process mode: Redis on loopback in the dependencies stack; the password is resolved into the address when the process starts
  assert.match(JSON.stringify(composeModel(root, "compose.deps.yml").services["redis"]!.ports), /"host_ip":"127\.0\.0\.1".*"published":"6379"/);
  const envFile = read(root, ".infra/env/local/gateway.env");
  assert.match(envFile, /^REDIS_URL=redis:\/\/default:\$\{secret:\/\/redis-password\}@127\.0\.0\.1:6379\/0$/m);
  assert.ok(!envFile.includes(pw));
  const pe = processEnvironment(root, "gateway")!;
  assert.equal(pe.vars["REDIS_URL"], `redis://default:${pw}@127.0.0.1:6379/0`);
  assert.ok(pe.secrets.includes("REDIS_URL"));
  // rotation of the password keeps the derived address in step, and only the affected containers need a restart
  const rot = apply(root, { hooks, rotate: ["secret:redis-password"] });
  const pw2 = read(root, ".infra/secrets/local/redis-password").trim();
  assert.notEqual(pw2, pw);
  assert.equal(read(root, ".infra/secrets/local/redis-url").trim(), `redis://default:${pw2}@redis:6379/0`);
  assert.deepEqual(rot.restart, ["catalog", "gateway", "redis"]);
  assert.equal(apply(root, { hooks }).applied.length, 0, "idempotent afterwards");
});

test("D3: no Redis without a declaration; an environment can switch it off or use an external one", skipNoCompose, () => {
  const none = workspace(PSO_DEV); apply(none.root, none.hooks ? { hooks: none.hooks } : {});
  const m = composeModel(none.root);
  assert.equal(m.services["redis"], undefined);
  assert.ok(!JSON.stringify(m).includes("REDIS"), "nothing about Redis in a workspace that does not declare it");
  const off = workspace({ ...PSO_DEV, environments: { local: env({ redis: { provider: "none" } }) }, redis: { clients: ["gateway"] } });
  apply(off.root, { hooks: off.hooks });
  assert.equal(composeModel(off.root).services["redis"], undefined);
  const ext = workspace({ ...PSO_DEV, environments: { local: env({ redis: { provider: "external" } }) }, redis: { clients: ["gateway"] } });
  const p = plan(ext.root, undefined, ext.hooks);
  assert.equal(p.resources.find((r) => r.id === "secret:redis-url")!.action, "supply", "an external Redis address is supplied by the operator, never generated");
  assert.equal(p.resources.find((r) => r.id === "secret:redis-password"), undefined);
});

test("D3: application settings per service and per environment; secrets as files; volumes, replicas and health start period", skipNoCompose, () => {
  const c = { ...PSO_DEV,
    environments: { local: env({ services: { gateway: { environment: { APP_MODE: "local-api" }, replicas: 2 } } }) },
    secrets: { "bus-secret": { generate: "random" } },
    services: {
      gateway: { environment: { APP_MODE: "api", PSO_CHANNELS_BUS_SECRET: "secret://bus-secret", PSO_CHANNELS_BUS: "redis" } },
      catalog: { environment: { CATALOG_PAGE_SIZE: "50" }, volumes: { uploads: "/var/lib/catalog/uploads" }, healthcheck: { startPeriod: "120s" } },
    },
  };
  assert.deepEqual(validateContract(c).filter((i) => i.severity === "error"), []);
  const { root, hooks } = workspace(c);
  apply(root, { hooks });
  const m = composeModel(root);
  const gw = m.services["gateway"]!, cat = m.services["catalog"]!;
  assert.equal(gw.environment!["APP_MODE"], "local-api", "the environment's value wins over the workspace-wide one");
  assert.equal(gw.environment!["PSO_CHANNELS_BUS"], "redis");
  assert.equal(gw.environment!["PSO_CHANNELS_BUS_SECRET"], undefined, "a secret is never a value in the compose file");
  assert.deepEqual(gw.secrets?.map((x) => `${x.source}:${x.target}`), ["bus-secret:PSO_CHANNELS_BUS_SECRET"]);
  assert.equal(gw.environment!["PSO_SECRET_FILES"], "PSO_CHANNELS_BUS_SECRET");
  assert.equal(gw.deploy?.replicas, 2);
  assert.equal(cat.environment!["CATALOG_PAGE_SIZE"], "50");
  assert.ok(cat.volumes?.some((v) => v.source === "catalog-uploads" && v.target === "/var/lib/catalog/uploads"));
  assert.ok(m.volumes?.["catalog-uploads"], "a named volume: kept by docker:down");
  assert.equal(cat.healthcheck?.start_period, "2m0s");
  assert.match(JSON.stringify(cat.healthcheck?.test), /https:\/\/catalog:8081\/actuator\/health/, "the health path is the one the workspace declares");
  const bus = read(root, ".infra/secrets/local/bus-secret").trim();
  assert.ok(!JSON.stringify(m).includes(bus));
  // process mode: the same variables, the secret resolved only when the process starts
  assert.match(read(root, ".infra/env/local/gateway.env"), /^PSO_CHANNELS_BUS_SECRET=secret:\/\/bus-secret$/m);
  assert.equal(processEnvironment(root, "gateway")!.vars["PSO_CHANNELS_BUS_SECRET"], bus);
});

test("D3: the contract refuses settings that would weaken the topology or leak a credential", () => {
  const codes = (c: unknown) => validateContract(c).filter((i) => i.severity === "error").map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(codes({ ...PSO_DEV, services: { gateway: { environment: { PSO_UPSTREAM_CATALOG_TLS: "false" } } } }), ["PSO_INFRA_ENV_RESERVED $.services.gateway.environment.PSO_UPSTREAM_CATALOG_TLS"]);
  assert.deepEqual(codes({ ...PSO_DEV, services: { gateway: { environment: { STRIPE_API_KEY: "sk_live_123" } } } }), ["PSO_INFRA_SECRET_IN_CONTRACT $.services.gateway.environment.STRIPE_API_KEY"]);
  assert.deepEqual(codes({ ...PSO_DEV, services: { gateway: { environment: { BROKER: "amqp://user:pw@host" } } } }), ["PSO_INFRA_SECRET_IN_CONTRACT $.services.gateway.environment.BROKER"]);
  assert.deepEqual(codes({ ...PSO_DEV, services: { gateway: { environment: { X_TOKEN: "secret://nope" } } } }), ["PSO_INFRA_UNKNOWN_SECRET $.services.gateway.environment.X_TOKEN"]);
  assert.deepEqual(codes({ ...PSO_DEV, services: { catalog: { volumes: { certs: "/run/pso/tls" } } } }), ["PSO_INFRA_VOLUME $.services.catalog.volumes.certs"]);
  assert.deepEqual(codes({ ...PSO_DEV, redis: { clients: { gateway: ["PORT"] } } }), ["PSO_INFRA_ENV_RESERVED $.redis.clients.gateway"]);
  assert.deepEqual(codes({ ...PSO_DEV, environments: { local: env({ redis: { provider: "container" } }) } }), ["PSO_INFRA_REDIS $.environments.local.redis"]);
  // identity settings belong to the infrastructure unless the application takes authentication over explicitly
  const { root, hooks } = workspace({ ...PSO_DEV, services: { gateway: { environment: { PSO_JWT_AUDIENCE: "mine" } } } });
  assert.throws(() => plan(root, undefined, hooks), (e: unknown) => e instanceof InfraError && e.code === "PSO_INFRA_ENV_RESERVED" && /authentication = "application"/.test(e.hint ?? ""));
  const two = workspace({ ...PSO_DEV, environments: { local: env({ publishServices: true }) }, services: { gateway: { replicas: 2 } } });
  assert.throws(() => plan(two.root, undefined, two.hooks), (e: unknown) => e instanceof InfraError && e.code === "PSO_INFRA_REPLICAS");
});

test("D5: authentication declared by the application: PSO gives that service no identity setting, in processes and in containers", skipNoCompose, () => {
  const c = { ...PSO_DEV, environments: { local: env({ services: { gateway: { authentication: "application", environment: { PSO_JWT_PUBLIC_KEY_FILE: "/run/app/public.pem" } } } }) } };
  assert.deepEqual(validateContract(c).filter((i) => i.severity === "error"), []);
  const { root, hooks } = workspace(c);
  apply(root, { hooks });
  const gwEnv = read(root, ".infra/env/local/gateway.env");
  assert.doesNotMatch(gwEnv, /^PSO_JWT_JWKS_URI=/m, "no infrastructure key source for a service that authenticates itself");
  assert.match(gwEnv, /^# authentication: configured by the application/m);
  assert.match(gwEnv, /^PSO_JWT_PUBLIC_KEY_FILE=\/run\/app\/public\.pem$/m);
  assert.match(read(root, ".infra/env/local/catalog.env"), /^PSO_JWT_JWKS_URI=/m, "the other services keep the environment's identity");
  const m = composeModel(root);
  const gw = m.services["gateway"]!;
  assert.deepEqual(Object.keys(gw.environment!).filter((k) => /^PSO_(JWT|SECURITY_JWT)_/.test(k)), ["PSO_JWT_PUBLIC_KEY_FILE"]);
  assert.equal(gw.depends_on?.["idp"], undefined, "it does not wait for a key server it does not use");
  assert.ok(m.services["catalog"]!.depends_on?.["idp"]);
  // per environment: the workspace-wide default is unchanged
  assert.equal(resolveTopology(JSON.parse(read(root, "pso.workspace.json")), { ...c, environments: { ...c.environments, ci: env({ domain: "ci.pso.localhost" }) } } as never, "ci", []).services.find((s) => s.name === "gateway")!.authentication, "infrastructure");
});

test("D5: pso dev never mixes the infrastructure's key source with the application's; a conflict the application creates itself is still reported", () => {
  const { root, hooks } = workspace({ ...PSO_DEV, environments: { local: env({ runtime: "process" }) } });
  apply(root, { hooks });
  const infra = processEnvironment(root, "gateway")!.vars;
  assert.ok(infra["PSO_JWT_JWKS_URI"] && infra["PSO_JWT_ISSUER"]);
  const security = (e: Record<string, string | undefined>) => { try { loadSecurityConfig({ projectDir: join(root, "gateway"), env: e as NodeJS.ProcessEnv }); return "ok"; } catch (x) { return ((x as { issues?: Array<{ code: string }> }).issues ?? []).map((i) => i.code).join(","); } };
  // the application selects a public key file (an application that issues its own tokens); rc.6 filled every unset variable, bringing the JWKS address back
  const app = { PSO_JWT_PUBLIC_KEY_FILE: join(root, "app-public.pem"), PSO_JWT_ISSUER: "https://app.example.test", PSO_JWT_AUDIENCE: "app", PSO_JWT_ALGORITHMS: "ES256" };
  const rc6 = { ...app }; for (const [k, v] of Object.entries(infra)) if ((rc6 as Record<string, string>)[k] === undefined) (rc6 as Record<string, string>)[k] = v;
  assert.match(security(rc6), /PSO_SEC_KEY_CONFLICT/, "the defect, reproduced with the rc.6 merge rule");
  const now: Record<string, string | undefined> = { ...app };
  const r = mergeProcessEnvironment(now, infra);
  assert.equal(now["PSO_JWT_JWKS_URI"], undefined, "the infrastructure's key source is not added");
  assert.equal(now["PSO_JWT_ISSUER"], "https://app.example.test", "nor its issuer: the identity settings are one group");
  assert.ok(!r.added.some((k) => /^PSO_(JWT|SECURITY_JWT)_/.test(k)));
  assert.match(r.skipped[0]!.reason, /selects its own key source \(PSO_JWT_PUBLIC_KEY_FILE\)/);
  assert.doesNotMatch(security(now), /PSO_SEC_KEY_CONFLICT/);
  // without a key source of its own, the service gets the infrastructure's identity, and an explicit value of the application still wins
  const plain: Record<string, string | undefined> = { PSO_JWT_AUDIENCE: "custom" };
  mergeProcessEnvironment(plain, infra);
  assert.equal(plain["PSO_JWT_JWKS_URI"], infra["PSO_JWT_JWKS_URI"]);
  assert.equal(plain["PSO_JWT_AUDIENCE"], "custom");
  // a real conflict (both sources set by the application itself) is never hidden
  const both: Record<string, string | undefined> = { ...app, PSO_JWT_JWKS_URI: "https://keys.example.test/jwks.json" };
  mergeProcessEnvironment(both, infra);
  assert.match(security(both), /PSO_SEC_KEY_CONFLICT/);
});

test("the container graph of a full topology (identity, Redis, databases, two FEIs) has no cycle and starts dependencies first", () => {
  const { root, hooks } = workspace({ ...PSO_DEV, redis: { clients: ["gateway", "catalog"] } });
  const t = plan(root, undefined, hooks).topology;
  const g = containerGraph(t);
  assert.equal(dependencyCycle(g), undefined);
  const order = startupOrder(t);
  for (const [n, ds] of Object.entries(g)) for (const d of ds) assert.ok(order.indexOf(d) < order.indexOf(n), `${d} before ${n}`);
  assert.deepEqual(dependencyCycle({ a: ["b"], b: ["c"], c: ["a"] }), ["a", "b", "c", "a"]);
});
