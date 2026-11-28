import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { apply, compose, edgeImage, ensureEdgeImage, environmentCa, localResolution, netRequest, plan, renderCompose, loadContract, type EngineHooks, type FrontendInfo } from "../src/index.ts";

/**
 * Runtime compatibility of the framework's edge image: what docker.images.nginx still governs, reuse of an existing image, the image's
 * build-time self-test, and the guarantee that a running edge keeps serving when a new configuration or image cannot be used.
 */
const fei = (name: string, port: number): FrontendInfo => ({ name, port, authentication: "jwt", microfrontends: [], scopes: [], orchestratorBasePath: "/api", routes: [] });
function workspace(contract: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "pso-edge-rt-"));
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "shop", services: [{ name: "gateway", path: "gateway", runtime: "node", role: "orchestrator", port: 3000, health: "/health/ready" }] }, null, 2));
  mkdirSync(join(root, "gateway"));
  writeFileSync(join(root, "pso.infra.json"), JSON.stringify(contract, null, 2));
  const fes = [fei("fei-shop", 4200), fei("fei-admin", 4300)];
  const hooks: EngineHooks = { frontends: () => ({ frontends: fes, scopes: [] }) };
  return { root, hooks };
}
const LOCAL = (extra: Record<string, unknown> = {}, env: Record<string, unknown> = {}) => ({ schemaVersion: 1, defaultEnvironment: "local", environments: { local: { kind: "development", domain: "pso.localhost", runtime: "docker", httpsPort: 8443, ...env } }, identity: { provider: "pso-dev" }, ...extra });
const service = (compose: string, name: string): string => { const i = compose.indexOf(`\n  ${name}:\n`); const rest = compose.slice(i + 1); const end = rest.slice(3).search(/\n  [a-z][a-z0-9-]*:\n/); return end < 0 ? rest : rest.slice(0, end + 3); };
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("docker.images.nginx governs the shells and the pso-dev key server, never the edge", () => {
  const { root, hooks } = workspace(LOCAL({ docker: { images: { nginx: "registry.example.test/mirror/nginx:1.27.5-alpine" } } })); dirs.push(root);
  apply(root, { hooks });
  const c = readFileSync(join(root, ".infra", "docker", "local", "compose.yml"), "utf8");
  for (const n of ["fei-shop", "fei-admin", "idp"]) assert.match(service(c, n), /image: "registry\.example\.test\/mirror\/nginx:1\.27\.5-alpine"/, n);
  assert.match(service(c, "edge"), new RegExp(`image: "${edgeImage().tag}"\\n    pull_policy: "never"`));
  assert.doesNotMatch(service(c, "edge"), /registry\.example\.test/);
});

test("the edge forwards the external authority (port included) and the orchestrator allows exactly the declared shells' origins", async () => {
  for (const [port, host] of [[8443, "$host:8443"], [443, "$host"]] as const) {
    const { root, hooks } = workspace(LOCAL({}, { httpsPort: port })); dirs.push(root);
    apply(root, { hooks });
    const conf = readFileSync(join(root, ".infra", "nginx", "local", "edge.conf"), "utf8");
    const orchestratorBlocks = conf.split("location ").filter((b) => b.includes("proxy_pass $pso_orchestrator;"));
    assert.ok(orchestratorBlocks.length >= 3 && orchestratorBlocks.every((b) => b.includes(`proxy_set_header Host ${host};`)), `port ${port}: Host ${host}`);
    assert.doesNotMatch(conf, /\$http_host|proxy_set_header Host \$http_x_forwarded/, "never a client-supplied authority");
    const t = plan(root, undefined, hooks).topology;
    const origins = readFileSync(join(root, ".infra", "docker", "local", "compose.yml"), "utf8").match(/PSO_CHANNELS_ALLOWED_ORIGINS: "([^"]*)"/)?.[1];
    assert.equal(origins, t.frontends.map((f) => f.origin).sort().join(","), `port ${port}`);
    assert.doesNotMatch(origins!, /\*/);
  }
  // the list the engine generates is accepted by PSO Channels where it is mandatory (production refuses to start without one)
  {
    const { root, hooks } = workspace(LOCAL({}, { httpsPort: 443 })); dirs.push(root);
    apply(root, { hooks });
    const origins = readFileSync(join(root, ".infra", "docker", "local", "compose.yml"), "utf8").match(/PSO_CHANNELS_ALLOWED_ORIGINS: "([^"]*)"/)![1]!;
    const { loadChannelsConfig } = await import("../../channels/src/config.ts");
    const env = { PSO_CHANNELS_ALLOWED_ORIGINS: origins, PSO_CHANNELS_BUS: "local", PSO_CHANNELS_ACK_SINGLE_INSTANCE: "true" };
    assert.deepEqual(loadChannelsConfig(undefined, env, "production").allowedOrigins, origins.split(","));
    assert.throws(() => loadChannelsConfig(undefined, { ...env, PSO_CHANNELS_ALLOWED_ORIGINS: "" }, "production"), /allowedOrigins/, "without it production refuses to start");
  }
  // an application that states its own list keeps it
  const { root, hooks } = workspace(LOCAL({ services: { gateway: { environment: { PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.test" } } } })); dirs.push(root);
  apply(root, { hooks });
  const t = plan(root, undefined, hooks).topology;
  assert.match(renderCompose(t, loadContract(root).contract), /PSO_CHANNELS_ALLOWED_ORIGINS: "https:\/\/app\.example\.test"/);
});

const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 300_000, windowsHide: true });
const dockerOk = docker("info", "--format", "{{.ServerVersion}}").status === 0;

test("the edge image: built once, then reused; it records its exact packages and passed its own nginx -t", { skip: dockerOk ? false : "Docker is not available", timeout: 900_000 }, async () => {
  const tag = edgeImage().tag;
  await ensureEdgeImage(tag);
  const lines: string[] = [];
  const t0 = Date.now();
  assert.equal(await ensureEdgeImage(tag, (l) => lines.push(l)), "present");
  assert.ok(Date.now() - t0 < 10_000 && !lines.some((l) => /building/.test(l)), "an existing image is reused without a build");
  const pk = docker("run", "--rm", tag, "cat", "/usr/share/edge/packages.txt");
  assert.match(pk.stdout, /^nginx-1\.30\.\d+-r\d+\nnginx-mod-http-headers-more-1\.30\.\d+-r\d+\n$/, pk.stdout + pk.stderr);
  await assert.rejects(ensureEdgeImage("pso-edge:0000000000000000"), /PSO_EDGE_IMAGE_FOREIGN|does not build/);
});

test("a running edge keeps serving when the new configuration is rejected or the image cannot be obtained", { skip: dockerOk ? false : "Docker is not available", timeout: 900_000 }, async () => {
  const { root, hooks } = workspace(LOCAL()); dirs.push(root);
  apply(root, { hooks });
  const t = plan(root, undefined, hooks).topology;
  const project = `pso-edge-rt-${randomBytes(3).toString("hex")}`;
  const file = join(root, "edge-only.compose.yml");
  const tag = edgeImage().tag;
  const yml = (image: string) => [
    "services:", "  edge:", `    image: "${image}"`, '    pull_policy: "never"', '    user: "101:101"', "    read_only: true",
    '    tmpfs: ["/tmp:mode=1777", "/var/cache/nginx:mode=1777", "/var/run:mode=1777"]',
    '    volumes: ["./.infra/nginx/local/edge.conf:/etc/nginx/conf.d/default.conf:ro", "./.infra/certs/local/edge:/run/pso/tls:ro"]',
    '    ports: ["127.0.0.1::8443"]', "",
  ].join("\n");
  writeFileSync(file, yml(tag));
  const target = { root, file, project };
  const log: string[] = [];
  try {
    assert.equal(await compose(target, ["up", "-d", "--wait"], { onLine: (l) => log.push(l) }), 0, log.join("\n"));
    assert.ok(log.some((l) => /accepted by nginx -t/.test(l)));
    const id = docker("compose", "-f", file, "-p", project, "ps", "-q", "edge").stdout.trim();
    const port = Number(/:(\d+)\s*$/m.exec(docker("port", id, "8443/tcp").stdout)![1]);
    const resolve = Object.fromEntries(Object.keys(localResolution(t)).map((h) => [h, "127.0.0.1"]));
    const serving = async () => { const r = await netRequest({ url: `http://${t.frontends[0]!.host}:${port}/`, resolve, timeoutMs: 10_000 }); return r.status === 400 && /Error 400/.test(r.body.toString()) && !r.headers["server"]; };
    void environmentCa;
    assert.ok(await serving(), "the edge serves");
    // 1. a configuration nginx rejects: nothing is started or re-created, the running edge keeps its configuration
    const confFile = join(root, ".infra", "nginx", "local", "edge.conf");
    const good = readFileSync(confFile, "utf8");
    writeFileSync(confFile, `${good}\nbogus_directive on;\n`);
    log.length = 0;
    assert.notEqual(await compose(target, ["up", "-d", "--wait", "--force-recreate"], { onLine: (l) => log.push(l) }), 0);
    assert.ok(log.some((l) => /rejected by nginx -t/.test(l)) && log.some((l) => /bogus_directive/.test(l)), log.join("\n"));
    assert.equal(docker("compose", "-f", file, "-p", project, "ps", "-q", "edge").stdout.trim(), id, "the same container, not re-created");
    assert.ok(await serving(), "and it still serves");
    writeFileSync(confFile, good);
    // 2. an image this release cannot build: refused before compose touches anything
    writeFileSync(file, yml("pso-edge:0000000000000000"));
    log.length = 0;
    assert.notEqual(await compose(target, ["up", "-d", "--wait"], { onLine: (l) => log.push(l) }), 0);
    assert.ok(log.some((l) => /does not build/.test(l)), log.join("\n"));
    assert.equal(docker("compose", "-f", file, "-p", project, "ps", "-q", "edge").stdout.trim(), id, "the running edge was not replaced");
    assert.ok(await serving(), "and it still serves");
  } finally {
    writeFileSync(file, yml(tag));
    docker("compose", "-f", file, "-p", project, "down", "--remove-orphans");
  }
});
