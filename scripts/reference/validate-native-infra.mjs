#!/usr/bin/env node
// Real validation of the native infrastructure of 0.2.0-rc.7 (D1 to D5): a workspace with two FEIs and a microfrontend, a Node
// orchestrator and a Spring service with PostgreSQL, the pso-dev identity, Redis, PSO Dispatch (transactional outbox -> Redis Streams) and
// PSO Channels over the Redis bus between TWO orchestrator replicas. Real CLI, real Docker Engine, real containers, TLS and JWT verified
// everywhere (nothing is bypassed). With --from-cli the workspace is created and provisioned by an earlier release first (upgrade path).
//
//   node scripts/reference/validate-native-infra.mjs --cli <pso.js of the candidate> [--from-cli <pso.js of rc.6>] [--port 8461]
//        [--evidence <dir>] [--keep]
//
// Every step prints its duration; every check prints PASS/FAIL. The only hand-written application code is the one line that calls the
// generated notifier from the generated product service (what an application does with a notifier).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const cli = flag("cli") ?? join(repo, "packages", "cli", "bin", "pso.js");
const fromCli = flag("from-cli");
const port = Number(flag("port") ?? 8461);
const redisPort = port + 10000;
const evidence = flag("evidence");
const keep = a.includes("--keep");
const { netRequest, environmentCa, localResolution, plan } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const { INFRA_HOOKS } = await import(new URL("../../packages/cli/dist/commands-infra.js", import.meta.url).href);

const results = [];
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s]`;
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, ...(detail ? { detail: String(detail).slice(0, 400) } : {}) }); console.log(`${stamp()} ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 400)}`}`); return !!ok; };
const run = (cwd, cmd, args, o = {}) => {
  const s = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: o.shell ?? false, timeout: o.timeout ?? 1_800_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1", FORCE_COLOR: "0", PSO_NO_BROWSER: "1", ...(o.env ?? {}) } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`${stamp()}   ${o.label ?? `${cmd} ${args.join(" ")}`.slice(0, 160)} -> exit ${r.status} (${((Date.now() - s) / 1000).toFixed(1)} s)`);
  if (r.status !== 0 && !o.quiet) console.log(out.split(/\r?\n/).slice(-15).map((l) => `      | ${l}`).join("\n"));
  return { code: r.status, out };
};
const psoWith = (bin) => (cwd, args, o = {}) => run(cwd, bin.endsWith(".cmd") ? bin : process.execPath, bin.endsWith(".cmd") ? args : [bin, ...args], { ...o, shell: bin.endsWith(".cmd"), label: `pso ${args.join(" ")}` });
const pso = psoWith(cli);
const old = fromCli ? psoWith(fromCli) : pso;
const docker = (args, o = {}) => run(process.cwd(), "docker", args, { quiet: true, ...o, label: `docker ${args.join(" ")}`.slice(0, 160) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = mkdtempSync(join(tmpdir(), "pso-native-")); const ws = join(base, "shop");
const project = `psonative-${randomBytes(3).toString("hex")}`;
const edit = (rel, fn) => { const f = join(ws, ...rel.split("/")); writeFileSync(f, fn(readFileSync(f, "utf8"))); };
let up = false;
try {
  // ---------------------------------------------------------------------------------------------------- 1. workspace (earlier release)
  console.log(`${stamp()} workspace ${ws} (compose project ${project}); candidate CLI ${cli}${fromCli ? `; created by ${fromCli}` : ""}`);
  check("create workspace", old(base, ["create", "workspace", "shop"]).code === 0);
  for (const c of [["service", "catalog", "--db", "postgres"], ["orchestrator", "gateway"], ["fei", "shop"], ["fei", "admin"], ["mei", "catalog", "--host", "shop", "--register"]]) check(`pso create ${c.join(" ")}`, old(ws, ["create", ...c]).code === 0);
  check("pso infra:init --identity pso-dev --runtime docker", old(ws, ["infra:init", "--identity", "pso-dev", "--runtime", "docker", "--users", "ana:products:read+products:write"]).code === 0);
  edit("pso.infra.json", (t) => { const c = JSON.parse(t); c.environments.local.httpsPort = port; c.docker = { project }; return JSON.stringify(c, null, 2) + "\n"; });
  check("pso infra:apply (earlier release)", old(ws, ["infra:apply", "--yes"]).code === 0);
  const svc = join(ws, "services", "catalog");
  if (fromCli) {
    // what an rc.6 workspace carries: the com.pso artifacts that release vendored, without a manifest
    const v = readFileSync(join(svc, "pom.xml"), "utf8").match(/<pso\.version>([^<]+)</)[1];
    const m2 = join(homedir(), ".m2", "repository", "com", "pso");
    for (const art of readdirSync(m2)) if (existsSync(join(m2, art, v)) && art !== "pso-integration-tests") cpSync(join(m2, art, v), join(svc, "vendor", "maven", "com", "pso", art, v), { recursive: true });
    check(`the earlier release left vendor/maven with com.pso ${v} (no manifest)`, existsSync(join(svc, "vendor", "maven", "com", "pso", "pso-bom", v)) && !existsSync(join(svc, "vendor", "maven", "com", "pso", "pso-vendor.json")));
  }

  // ---------------------------------------------------------------------------------------------------- 2. upgrade to the candidate
  // the PSO Java release the candidate CLI is bound to (its compiled specs module)
  const specs = [join(cli, "..", "..", "dist", "specs.js"), join(cli, "..", "..", "node_modules", "@pso", "cli", "dist", "specs.js")].find((f) => existsSync(f));
  const javaVersion = (specs ? readFileSync(specs, "utf8") : "").match(/PSO_JAVA_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? readFileSync(join(repo, "packages", "cli", "src", "specs.ts"), "utf8").match(/PSO_JAVA_VERSION = "([^"]+)"/)[1];
  // the candidate's artifacts: from its release repository (--java-from), or already installed. A checkout's own java:install would rebuild
  // its SNAPSHOT, which other projects of this machine may use: never done here
  const javaFrom = flag("java-from");
  if (javaFrom) check(`pso java:install --from (com.pso ${javaVersion} into the local Maven repository)`, pso(ws, ["java:install", "--from", javaFrom]).code === 0);
  else check(`com.pso ${javaVersion} is in the local Maven repository`, existsSync(join(homedir(), ".m2", "repository", "com", "pso", "pso-bom", javaVersion)));
  edit("services/catalog/pom.xml", (t) => t.replace(/<pso\.version>[^<]+<\/pso\.version>/, `<pso.version>${javaVersion}</pso.version>`));
  const p0 = pso(ws, ["infra:plan", "--env", "local"]);
  if (fromCli) check("the candidate's plan updates the earlier provisioning (key server, its certificate, compose, edge, process environments)", /nginx:idp/.test(p0.out) && /cert:idp/.test(p0.out) && /docker:compose/.test(p0.out), p0.out.split("\n").filter((l) => /create|update/i.test(l)).slice(0, 12).join(" | "));

  // ---------------------------------------------------------------------------------------------------- 3. Dispatch, Channels, Redis
  for (const c of [["dispatch:install", "redis", "--service", "catalog"], ["dispatch:outbox", "--service", "catalog"], ["channels:enable", "--service", "catalog"],
    ["make:notifier", "product-changed", "--service", "catalog", "--channel", "products", "--event", "product.changed", "--fields", "id:string,name:string", "--durable"],
    ["dispatch:install", "redis", "--service", "gateway"], ["channels:enable", "--service", "gateway"],
    ["make:channel", "products", "products", "--pattern", "products", "--publisher", "catalog", "--event", "product.changed", "--fields", "id:string,name:string", "--service", "gateway"]]) check(`pso ${c.join(" ")}`, pso(ws, c).code === 0);
  // the application calls its notifier where products change (the generated service does not know the application's events)
  edit("services/catalog/src/main/java/com/pso/catalog/application/service/ProductService.java", (t) => t
    .replace("import org.springframework.transaction.annotation.Transactional;", "import org.springframework.transaction.annotation.Transactional;\nimport com.pso.catalog.application.event.ProductChangedEvent;")
    .replace("    private final ProductMapper mapper;\n", "    private final ProductMapper mapper;\n    private final ProductChangedNotifier notifier;\n")
    .replace("        ProductEntity entity = mapper.toEntity(request);\n        return mapper.toResponse(saveAndFlush(entity));", "        ProductEntity entity = mapper.toEntity(request);\n        ProductResponse saved = mapper.toResponse(saveAndFlush(entity));\n        notifier.notify(new ProductChangedEvent(String.valueOf(saved.id()), saved.name()));\n        return saved;"));
  edit("pso.infra.json", (t) => {
    const c = JSON.parse(t);
    c.redis = { clients: { gateway: ["REDIS_URL", "PSO_CHANNELS_REDIS_URL"], catalog: ["REDIS_URL"] } };
    c.environments.local.redis = { port: redisPort };
    c.environments.local.services = { gateway: { replicas: 2 } };
    c.secrets = { ...(c.secrets ?? {}), "channels-bus-secret": { description: "signs the Redis bus of PSO Channels between orchestrator instances", generate: "random" } };
    c.services = { ...(c.services ?? {}),
      gateway: { environment: { PSO_DISPATCH_ENABLED: "true", PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_BUS_SECRET: "secret://channels-bus-secret" } },
      catalog: { environment: { PSO_DISPATCH_ENABLED: "true" }, healthcheck: { startPeriod: "90s" } } };
    return JSON.stringify(c, null, 2) + "\n";
  });
  check("pso infra:apply (the candidate provisions the key server, Redis secrets and the new settings)", pso(ws, ["infra:apply", "--env", "local", "--yes"]).code === 0);
  check("pso infra:validate (the contract with Redis, application settings and replicas)", pso(ws, ["infra:validate", "--env", "local"]).code === 0);
  const dp = pso(ws, ["docker:plan", "--env", "local"]);
  check("docker:plan: key server, Redis (password, persistent volume), two gateway replicas", /idp\s+identity provider\s+nginx/.test(dp.out) && /redis\s+redis\s+redis:7\.4-alpine\s+secrets redis-password\s+volume redis-data \(persistent\)/.test(dp.out) && /gateway.*x2/.test(dp.out), dp.out);

  // ---------------------------------------------------------------------------------------------------- 4. D1: vendor refresh
  const stale = pso(ws, ["docker:build", "--env", "local", "--service", "catalog"]);
  if (fromCli) check("D1: without --vendor the outdated vendor directory is named, with the fix, before any build", stale.code !== 0 && /vendor\/maven is (outdated|unverified)/.test(stale.out) && /Re-run with --vendor/.test(stale.out), stale.out.slice(-400));
  const b1 = pso(ws, ["docker:build", "--env", "local", "--vendor"]);
  check("D1: docker:build --vendor refreshes vendor/maven to the candidate and the images build", b1.code === 0 && (fromCli ? /refreshed services\/catalog\/vendor\/maven .* to com\.pso/.test(b1.out) : /vendor\/maven/.test(b1.out)), b1.out.split("\n").filter((l) => /vendor|refreshed|error/i.test(l)).slice(0, 8).join(" | "));
  const manifest = JSON.parse(readFileSync(join(svc, "vendor", "maven", "com", "pso", "pso-vendor.json"), "utf8"));
  check(`D1: vendor/maven holds com.pso ${javaVersion} only, with a manifest of every file`, manifest.version === javaVersion && readdirSync(join(svc, "vendor", "maven", "com", "pso", "pso-bom")).join() === javaVersion && Object.keys(manifest.files).length > 10);
  const b2 = pso(ws, ["docker:build", "--env", "local", "--vendor", "--service", "catalog"]);
  check("D1: a second docker:build --vendor finds the vendor directory current (idempotent)", b2.code === 0 && /vendor\/maven: com\.pso .* is current \(SHA-256 verified\)/.test(b2.out), b2.out.slice(-300));

  // ---------------------------------------------------------------------------------------------------- 5. frontends
  for (const d of ["frontends/fei-shop", "frontends/fei-admin", "frontends/modules/mei-catalog"]) check(`npm install in ${d}`, run(join(ws, ...d.split("/")), "npm", ["install", "--no-audit", "--no-fund"], { shell: true, timeout: 900_000 }).code === 0);
  check("pso frontend:build --env local", pso(ws, ["frontend:build", "--env", "local"]).code === 0);
  check("pso frontend:publish --all --env local", pso(ws, ["frontend:publish", "--all", "--env", "local"]).code === 0);

  // ---------------------------------------------------------------------------------------------------- 6. D2: one docker:up, no manual order
  const u = pso(ws, ["docker:up", "--env", "local", "--timeout", "600"]); up = true;
  check("D2: a single pso docker:up starts every container healthy, in dependency order, without any manual step", u.code === 0, u.out.split("\n").slice(-12).join(" | "));
  const order = (u.out.match(/in dependency order: (.*)/) ?? [])[1] ?? "";
  check("D2: the key server starts before the services, the edge last", /idp.*gateway.*edge/.test(order) && /redis.*catalog/.test(order), order);
  const rows = (svcName) => docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${svcName}`]).out.trim().split(/\s+/).filter(Boolean);
  check("two gateway replicas are running", rows("gateway").length === 2, rows("gateway").join(","));

  // ---------------------------------------------------------------------------------------------------- 7. D4: authenticated requests end to end
  const p = plan(ws, "local", INFRA_HOOKS); const t = p.topology, ca = environmentCa(ws, t), map = localResolution(t);
  const http = async (method, url, token, body) => { const x = await netRequest({ url, method, ca, resolve: map, timeoutMs: 30_000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: x.status, text: x.body.toString("utf8") }; };
  const tokenOf = () => (pso(ws, ["infra:token", "--env", "local", "--user", "ana", "--scopes", "products:read,products:write"], { quiet: true }).out.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/) ?? [])[0];
  const token = tokenOf();
  check("a development token is issued (pso infra:token)", !!token);
  check("the public key set is published under the identity's host, over verified TLS", /"keys"/.test((await http("GET", `${t.identity.issuer}/.well-known/jwks.json`)).text));
  check("D4: GET /products without a token -> 401", (await http("GET", `${t.api.origin}/products`)).status === 401);
  const list = await http("GET", `${t.api.origin}/products`, token);
  check("D4: GET /products with a token -> 200 (the gateway AND the Spring service validated it against the key server)", list.status === 200, `${list.status} ${list.text.slice(0, 200)}`);
  const foreign = (() => { const k = generateKeyPairSync("ec", { namedCurve: "P-256" }); const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const h = b({ alg: "ES256", typ: "JWT", kid: "x" }), pl = b({ iss: t.identity.issuer, aud: t.identity.audience, sub: "mallory", scp: ["products:read"], exp: Math.floor(Date.now() / 1000) + 600 }); return `${h}.${pl}.${b({ forged: true })}`; })();
  check("a token not signed by the environment's key is refused (401)", (await http("GET", `${t.api.origin}/products`, foreign)).status === 401);
  check("pso infra:validate --probe (TLS verified on every public host, readiness through the edge)", pso(ws, ["infra:validate", "--env", "local", "--probe"]).code === 0);

  // ---------------------------------------------------------------------------------------------------- 8. D3: Redis, Dispatch, Channels across replicas
  const [g1, g2] = rows("gateway");
  /** a WebSocket client INSIDE one replica (its own TLS endpoint, its own name): subscribed resolves when the server acknowledged */
  const client = (container, name) => {
    const src = `const W=require("ws");const fs=require("fs");const s=new W("wss://127.0.0.1:3000/channels","pso.channels.v1",{ca:fs.readFileSync("/run/pso/tls/ca.crt"),servername:"gateway"});const out=(o)=>{console.log(JSON.stringify(o));process.exit(0)};setTimeout(()=>out({timeout:true}),90000);s.on("message",(m)=>{const f=JSON.parse(m);if(f.t==="ready")s.send(JSON.stringify({v:1,t:"auth",token:process.env.T}));else if(f.t==="ack"&&f.authenticated)s.send(JSON.stringify({v:1,t:"subscribe",id:"1",channel:"products"}));else if(f.t==="ack"&&f.channel)console.log(JSON.stringify({subscribed:true}));else if(f.t==="event"&&f.payload&&f.payload.name===process.env.N)out({received:f.type,payload:f.payload});else if(f.t==="error")out({error:f.code})});s.on("error",(e)=>out({socket:e.message}));`;
    const c = spawn("docker", ["exec", "-e", `T=${token}`, "-e", `N=${name}`, "-w", "/app", container, "node", "-e", src], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = ""; c.stdout.on("data", (d) => { buf += d; }); c.stderr.on("data", (d) => { buf += d; });
    const subscribed = new Promise((r) => { const i = setInterval(() => { if (buf.includes('"subscribed"')) { clearInterval(i); r(true); } }, 200); setTimeout(() => { clearInterval(i); r(false); }, 30_000); });
    const result = new Promise((done) => c.on("exit", () => done({ lines: buf.trim().split("\n").filter(Boolean) })));
    return { subscribed, result };
  };
  const name = `lamp-${randomBytes(3).toString("hex")}`;
  const k1 = client(g1, name), k2 = client(g2, name);
  const subs = await Promise.all([k1.subscribed, k2.subscribed]);
  const c1 = k1.result, c2 = k2.result;
  check("Channels: a WebSocket client is subscribed on EACH gateway replica (wss, token in the auth frame)", subs.every(Boolean));
  const created = await http("POST", `${t.api.origin}/products`, token, { sku: name.toUpperCase(), name, price: "10.50", active: true });
  check("POST /products -> 201 (the Spring service stores the product and the event in one transaction)", created.status === 201, `${created.status} ${created.text.slice(0, 200)}`);
  const [r1, r2] = await Promise.all([c1, c2]);
  const got = (r) => r.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((o) => o.received);
  check("D3: the event travels outbox -> Dispatch (Redis Streams) -> one replica -> Channels Redis bus -> the client on replica 1", got(r1)?.received === "product.changed" && got(r1)?.payload?.name === name, r1.lines.join(" "));
  check("D3: ... and the client on replica 2 (WebSocket between several gateways)", got(r2)?.received === "product.changed" && got(r2)?.payload?.name === name, r2.lines.join(" "));
  const redis = rows("redis")[0];
  const noAuth = docker(["exec", redis, "redis-cli", "-p", "6379", "ping"]);
  check("Redis refuses a client without the password", /NOAUTH/.test(noAuth.out), noAuth.out.trim());
  const inspect = docker(["inspect", redis, "--format", "{{json .NetworkSettings.Ports}} {{json .NetworkSettings.Networks}}"]).out;
  check("Redis is on the private network only and publishes no port", /"6379\/tcp":null/.test(inspect) && /_internal"/.test(inspect) && !/_edge"/.test(inspect), inspect.slice(0, 300));
  const edgeC = rows("edge")[0];
  check("the edge (public) cannot even resolve Redis", docker(["exec", edgeC, "sh", "-c", "nslookup redis 127.0.0.11 >/dev/null 2>&1 && echo reachable || echo isolated"]).out.includes("isolated"));
  const secretValues = ["redis-password", "channels-bus-secret", "db-catalog"].map((n) => readFileSync(join(ws, ".infra", "secrets", "local", n), "utf8").trim());
  const envDump = [g1, rows("catalog")[0], redis].map((c) => docker(["inspect", c, "--format", "{{json .Config.Env}} {{json .Config.Cmd}} {{json .Config.Entrypoint}}"]).out).join("\n");
  check("no secret value is in any container's environment, command or the compose file", secretValues.every((v) => !envDump.includes(v) && !readFileSync(join(ws, ".infra", "docker", "local", "compose.yml"), "utf8").includes(v)));
  const streams = docker(["exec", "-e", `REDISCLI_AUTH=${secretValues[0]}`, redis, "redis-cli", "--scan", "--pattern", "*"]).out.trim().split(/\s+/).filter(Boolean);
  check("Dispatch keeps its stream in Redis", streams.some((k) => /channels/.test(k)), streams.join(","));

  // ---------------------------------------------------------------------------------------------------- 9. recovery and persistence
  for (const c of ["idp", "edge", "redis"]) docker(["restart", rows(c)[0]]);
  // the process of one replica ends (as a crash would): the restart policy brings it back. `docker kill` would count as a manual stop
  docker(["exec", g1, "kill", "-TERM", "1"]);
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) { await sleep(3000); const r = pso(ws, ["docker:ps", "--env", "local", "--json"], { quiet: true }); try { const j = JSON.parse(r.out); const list = Array.isArray(j) ? j : j.containers; healthy = list.length >= 9 && list.every((x) => x.state === "running" && (x.health === "" || x.health === "healthy")); } catch { /* not yet */ } }
  check("after restarting the key server, the edge and Redis and ending a gateway replica's process, every container is healthy again", healthy);
  check("after the restarts: an authenticated request still succeeds", (await http("GET", `${t.api.origin}/products`, tokenOf())).status === 200);
  check("pso docker:down keeps the volumes", pso(ws, ["docker:down", "--env", "local"]).code === 0);
  const again = pso(ws, ["docker:up", "--env", "local", "--timeout", "600"]);
  check("D2: after a full stop, a single docker:up brings the stack back (clean recovery, no ordering by hand)", again.code === 0, again.out.slice(-400));
  const after = await http("GET", `${t.api.origin}/products?sku=${name.toUpperCase()}`, tokenOf());
  check("persistence: the product created before the restart is still in PostgreSQL", after.status === 200 && after.text.includes(name), after.text.slice(0, 200));
  const keys2 = docker(["exec", "-e", `REDISCLI_AUTH=${secretValues[0]}`, rows("redis")[0], "redis-cli", "--scan", "--pattern", "*"]).out;
  check("persistence: Redis kept its data across the re-creation (append-only file in the redis-data volume)", /channels/.test(keys2), keys2.trim().slice(0, 200));
  check("pso docker:down", pso(ws, ["docker:down", "--env", "local"]).code === 0); up = false;

  // ---------------------------------------------------------------------------------------------------- 10. D5: process mode
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = join(base, "app-public.pem"); writeFileSync(pem, keys.publicKey.export({ type: "spki", format: "pem" }));
  const appAuth = { PSO_JWT_PUBLIC_KEY_FILE: pem, PSO_JWT_ISSUER: "https://app.example.test", PSO_JWT_AUDIENCE: "app", PSO_JWT_ALGORITHMS: "ES256" };
  const de = pso(ws, ["dev:env", "--service", "gateway"], { env: appAuth });
  check("D5: pso dev:env names the source of every variable and says which infrastructure identity settings are not applied, and why", /not applied from \.infra\/env\/local\/gateway\.env: PSO_JWT_/.test(de.out) && /selects its own key source \(PSO_JWT_PUBLIC_KEY_FILE\)/.test(de.out) && /REDIS_URL\s+\.infra\/env\/local\/gateway\.env\s+\[secret/.test(de.out) && !secretValues.some((v) => de.out.includes(v)), de.out.slice(0, 600));
  const d1 = pso(ws, ["dev", "--service", "gateway", "--with-dependencies", "--install", "--smoke", "--timeout", "300"]);
  check("process mode, identity of the infrastructure: the gateway starts against the key server and Redis of the dependencies stack", d1.code === 0 && /starting infrastructure dependencies: .*idp/.test(d1.out) && /redis/.test(d1.out), d1.out.split("\n").filter((l) => /error|ready|dependencies|PSO_/i.test(l)).slice(0, 8).join(" | "));
  const d2 = pso(ws, ["dev", "--service", "gateway", "--with-dependencies", "--smoke", "--timeout", "300"], { env: appAuth });
  check("D5: process mode, the application's own key source: the gateway starts (rc.6: PSO_SEC_KEY_CONFLICT)", d2.code === 0 && !/PSO_SEC_KEY_CONFLICT/.test(d2.out) && /not applied from \.infra\/env\/local\/gateway\.env/.test(d2.out), d2.out.split("\n").filter((l) => /error|not applied|KEY/i.test(l)).slice(0, 6).join(" | "));
  const both = pso(ws, ["dev", "--service", "gateway", "--with-dependencies", "--smoke", "--timeout", "120"], { env: { ...appAuth, PSO_JWT_JWKS_URI: "https://keys.example.test/jwks.json" } });
  check("D5: a conflict the application itself creates is still refused (PSO_SEC_KEY_CONFLICT)", both.code !== 0 && /PSO_SEC_KEY_CONFLICT/.test(both.out));
} finally {
  if (up && !keep) pso(ws, ["docker:down", "--env", "local", "--volumes", "--yes"]);
  else if (!keep) { pso(ws, ["docker:down", "--env", "local", "--volumes", "--yes"], { quiet: true }); run(ws, process.execPath, [cli, "docker:down", "--env", "local", "--volumes", "--yes"], { quiet: true, label: "cleanup" }); }
  const failed = results.filter((r) => !r.ok).length;
  if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "native-infra.json"), JSON.stringify({ cli, fromCli: fromCli ?? null, port, results, durationSeconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() }, null, 2)); }
  if (!keep) { try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } }
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed ? 1 : 0;
}
