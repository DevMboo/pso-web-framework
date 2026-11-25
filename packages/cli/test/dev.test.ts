import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { WorkspaceConfig } from "@pso/core";
import { startDev, portFree, readRegistry } from "../src/dev.ts";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold a handle on a just-killed process cwd; temp dir is reaped by the OS */ } } });

const STUB = `import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ORDER_FILE, process.env.PSO_SERVICE + "\\n");
const s = createServer((q, r) => { r.writeHead(q.url === "/health" ? 200 : 404); r.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => s.close(() => process.exit(0)));
`;

async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  const servers = [];
  for (let i = 0; i < n; i++) {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    out.push((s.address() as { port: number }).port);
    servers.push(s);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return out;
}

async function workspace(spec: Array<{ name: string; deps?: string[]; command?: string[] }>) {
  const root = tmp("pso-dev-"); dirs.push(root);
  const ports = await freePorts(spec.length);
  writeFileSync(join(root, "stub.mjs"), STUB);
  const orderFile = join(root, "order.txt");
  writeFileSync(orderFile, "");
  process.env["ORDER_FILE"] = orderFile;
  const config: WorkspaceConfig = {
    schemaVersion: 1, name: "w",
    services: spec.map((s, i) => {
      mkdirSync(join(root, s.name, "src"), { recursive: true });
      return { name: s.name, path: s.name, runtime: "node" as const, port: ports[i]!, dependsOn: s.deps ?? [], health: "/health", dev: { command: s.command ?? [process.execPath, join(root, "stub.mjs")] } };
    }),
  };
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify(config, null, 2));
  return { root, config, ports, order: () => readFileSync(orderFile, "utf8").split("\n").filter(Boolean) };
}

test("starts in dependency order, publishes a live registry, stops cleanly and frees ports", async () => {
  const w = await workspace([{ name: "c", deps: ["b"] }, { name: "b", deps: ["a"] }, { name: "a" }]);
  const s = await startDev({ root: w.root, config: w.config, readyTimeoutMs: 20_000, healthIntervalMs: 200 });
  try {
    assert.deepEqual(w.order(), ["a", "b", "c"]);
    const reg = readRegistry(w.root)!;
    assert.deepEqual(reg.services.map((x) => [x.name, x.state, x.status]), [["c", "READY", "UP"], ["b", "READY", "UP"], ["a", "READY", "UP"]]);
    assert.ok(reg.services.every((x) => typeof x.pid === "number"));
    // real HTTP against a registered service
    assert.equal((await fetch(`http://127.0.0.1:${w.ports[2]}/health`)).status, 200);
  } finally { await s.stop(); }
  for (const p of w.ports) assert.equal(await portFree(p), true, `port ${p} released`);
  assert.ok(readRegistry(w.root)!.services.every((x) => x.state === "STOPPED"));
});

test("health monitoring notices a service that dies", async () => {
  const w = await workspace([{ name: "a" }, { name: "b" }]);
  const s = await startDev({ root: w.root, config: w.config, readyTimeoutMs: 20_000, healthIntervalMs: 150 });
  try {
    const victim = s.registry().find((x) => x.name === "b")!;
    process.kill(victim.pid!);
    let status = "UP";
    for (let i = 0; i < 40 && status !== "DOWN"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = readRegistry(w.root)!.services.find((x) => x.name === "b")!.status;
    }
    assert.equal(status, "DOWN");
    assert.equal(readRegistry(w.root)!.services.find((x) => x.name === "a")!.status, "UP", "healthy neighbour unaffected");
  } finally { await s.stop(); }
});

test("port conflict is detected before starting and nothing is left running", async () => {
  const w = await workspace([{ name: "a" }, { name: "b", deps: ["a"] }]);
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(w.ports[1]!, "127.0.0.1", r));
  try {
    await assert.rejects(startDev({ root: w.root, config: w.config, readyTimeoutMs: 10_000 }), /port \d+ is already in use/);
    assert.equal(await portFree(w.ports[0]!), true, "service a was rolled back");
  } finally { blocker.close(); }
});

test("a service that crashes during startup aborts and rolls back earlier services", async () => {
  const w = await workspace([{ name: "a" }, { name: "b", deps: ["a"], command: [process.execPath, "-e", "process.exit(3)"] }, { name: "c", deps: ["b"] }]);
  await assert.rejects(startDev({ root: w.root, config: w.config, readyTimeoutMs: 10_000 }), /exited with code 3/);
  assert.equal(await portFree(w.ports[0]!), true);
  assert.deepEqual(w.order(), ["a"], "dependent c never started");
  const reg = readRegistry(w.root)!.services;
  assert.equal(reg.find((x) => x.name === "b")!.state, "FAILED");
  assert.notEqual(reg.find((x) => x.name === "c")!.state, "READY");
});

test("a service that never becomes ready times out", async () => {
  const w = await workspace([{ name: "a", command: [process.execPath, "-e", "setInterval(()=>{},1000)"] }]);
  await assert.rejects(startDev({ root: w.root, config: w.config, readyTimeoutMs: 1200 }), /not ready after 1200 ms/);
  assert.equal(readRegistry(w.root)!.services[0]!.state, "FAILED");
});

test("CLI: pso dev --smoke starts, reports and stops; invalid workspace is refused; services:health reflects reality", async () => {
  const w = await workspace([{ name: "a" }, { name: "b", deps: ["a"] }]);
  const smoke = await pso(w.root, "dev", "--smoke", "--timeout", "20");
  assert.equal(smoke.code, 0, smoke.out + smoke.err);
  assert.match(smoke.out, /Ready:/);
  assert.match(smoke.out, /all services stopped/);
  assert.equal((await pso(w.root, "services:health", "--json")).code, 1, "nothing running -> DOWN");

  const s = await startDev({ root: w.root, config: w.config, readyTimeoutMs: 20_000 });
  try {
    const h = await pso(w.root, "services:health", "--json");
    assert.equal(h.code, 0);
    assert.deepEqual(JSON.parse(h.out).map((r: { status: string }) => r.status), ["UP", "UP"]);
    const insp = await pso(w.root, "services:inspect", "b", "--json");
    assert.equal(JSON.parse(insp.out).health.status, "UP");
  } finally { await s.stop(); }

  const bad = JSON.parse(readFileSync(join(w.root, "pso.workspace.json"), "utf8"));
  bad.services[1].port = bad.services[0].port;
  writeFileSync(join(w.root, "pso.workspace.json"), JSON.stringify(bad));
  const refused = await pso(w.root, "dev", "--smoke");
  assert.equal(refused.code, 1);
  assert.match(refused.out + refused.err, /PSO_PORT_CONFLICT/);
});

test("CLI: services:register validates, unregister refuses while depended upon", async () => {
  const w = await workspace([{ name: "a" }, { name: "b", deps: ["a"] }]);
  mkdirSync(join(w.root, "extra"));
  assert.equal((await pso(w.root, "services:register", "extra", "--port", String(w.ports[0]), "--runtime", "node")).code, 1, "port conflict refused");
  const ok = await pso(w.root, "services:register", "extra", "--port", "47123", "--runtime", "node", "--depends-on", "a", "--dry-run");
  assert.equal(ok.code, 0);
  assert.ok(!readFileSync(join(w.root, "pso.workspace.json"), "utf8").includes("extra"), "dry-run does not save");
  assert.equal((await pso(w.root, "services:register", "extra", "--port", "47123", "--runtime", "node", "--depends-on", "a")).code, 0);
  assert.equal((await pso(w.root, "services:register", "x", "--port", "47124", "--runtime", "node", "--path", "../out")).code, 1, "path escape refused");
  assert.equal((await pso(w.root, "services:unregister", "a")).code, 1, "a is required by b and extra");
  assert.equal((await pso(w.root, "services:unregister", "extra")).code, 0);
});
