import { WORKSPACE, FRAMEWORK } from "./config.mjs";
// Bounded availability measurement: light continuous traffic (about 6 req/s) while a PSO command runs. Usage: node avail.mjs <label> -- <pso args...>
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { call, tokenFor } from "./ecv.mjs";
const [label, , ...psoArgs] = process.argv.slice(2);
const ids = JSON.parse(readFileSync(`${WORKSPACE}/.tls/ids.json`, "utf8"));
const token = tokenFor("customers:read catalog:read orders:read");
const recs = []; let running = true; const t0 = Date.now();
const paths = [`/overview/orders/${ids.orderId}`, `/products/${ids.productId}`];
const worker = async (n) => { let i = n; while (running) { const p = paths[i++ % paths.length]; const s = Date.now(); try { const r = await call("GET", p, { token }); recs.push({ t: s - t0, ms: Date.now() - s, status: r.status, p, v2: p.startsWith("/products") && r.json && "description" in r.json }); } catch (e) { recs.push({ t: s - t0, ms: Date.now() - s, status: 0, p, err: String(e.code ?? e.message).slice(0, 40) }); } await new Promise((r) => setTimeout(r, 450)); } };
const workers = [0, 1, 2].map(worker);
await new Promise((r) => setTimeout(r, 2500)); // baseline before the operation
const opStart = Date.now() - t0;
const code = await new Promise((res) => { const c = spawn(process.execPath, [`${FRAMEWORK}/packages/cli/bin/pso.js`, ...psoArgs], { cwd: `${WORKSPACE}`, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("close", (x) => { globalThis.__out = out; res(x); }); });
const opEnd = Date.now() - t0;
await new Promise((r) => setTimeout(r, 3000)); running = false; await Promise.all(workers);
const ok = recs.filter((r) => r.status >= 200 && r.status < 300); const bad = recs.filter((r) => !(r.status >= 200 && r.status < 300));
const lat = ok.map((r) => r.ms).sort((a, b) => a - b); const q = (x) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))] ?? 0;
const v2 = recs.filter((r) => r.v2); const firstV2 = v2[0]?.t;
const summary = { label, command: `pso ${psoArgs.join(" ")}`, exitCode: code, operationMs: opEnd - opStart, requests: recs.length, ok: ok.length, failed: bad.length, failures: bad.slice(0, 8).map((r) => ({ at: r.t, status: r.status, err: r.err, p: r.p })), latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat[lat.length - 1] ?? 0 }, newReleaseFirstSeenAtMs: firstV2 ?? null, operationWindowMs: [opStart, opEnd] };
console.log(JSON.stringify(summary, null, 1));
console.log("--- command tail ---\n" + (globalThis.__out ?? "").split("\n").filter((l) => /^(deploy|rollback|deployment|error|  (COMPLETED|FAILED)|  active-release)/.test(l)).slice(-5).join("\n").slice(0, 700));
mkdirSync(`${FRAMEWORK}/docs/implementation/evidence/ecv`, { recursive: true });
writeFileSync(`${FRAMEWORK}/docs/implementation/evidence/ecv/avail-${label}.json`, JSON.stringify(summary, null, 2));
