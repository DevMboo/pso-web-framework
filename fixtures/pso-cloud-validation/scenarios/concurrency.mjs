import { WORKSPACE, FRAMEWORK, HOST, SSH_KEY, SSH_USER } from "./config.mjs";
// 12 orders for a product with stock 8, placed while the catalog (a consumer + outbox publisher) is redeployed blue-green: two releases overlap.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { call, tokenFor } from "./ecv.mjs";
const token = tokenFor("customers:read customers:write catalog:read catalog:write orders:read orders:write");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (cmd) => spawnSync("ssh", ["-i", `${SSH_KEY}`, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${join(homedir(), ".pso-cloud", "known_hosts")}`, `${SSH_USER}@${HOST}`, cmd], { encoding: "utf8" }).stdout.trim();
const cust = (await call("POST", "/customers", { token, body: { name: "Concurrency Buyer", email: `conc-${Date.now()}@example.test` } })).json;
const prod = (await call("POST", "/products", { token, body: { sku: `CONC-${Date.now()}`, name: "Scarce Widget", priceCents: 500, stock: 8, description: "stock of 8" } })).json;
const D = spawn(process.execPath, [`${FRAMEWORK}/packages/cli/bin/pso.js`, "release:deploy", "shop-catalog", "--approve", "--yes"], { cwd: `${WORKSPACE}`, stdio: "ignore" });
const deploy = new Promise((r) => D.on("close", r));
await sleep(25000); // let the new catalog release start (the upload takes about 20 s); orders then overlap with the switch
const placed = []; const t0 = Date.now();
for (let i = 0; i < 12; i++) { const r = await call("POST", "/orders", { token, body: { customerId: cust.id, productId: prod.id, quantity: 1 } }).catch((e) => ({ status: 0, err: e.message })); placed.push({ i, status: r.status, id: r.json?.id }); await sleep(650); }
const code = await deploy;
const ids = placed.filter((p) => p.id).map((p) => p.id); let states = {};
for (let k = 0; k < 40; k++) { states = {}; for (const id of ids) { const g = await call("GET", `/orders/${id}`, { token }); states[id] = g.json?.status; } if (Object.values(states).every((s) => s && s !== "PENDING")) break; await sleep(1500); }
const tally = Object.values(states).reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {});
const stock = (await call("GET", `/products/${prod.id}`, { token })).json?.stock;
const sql = (db, q) => ssh(`sudo -u postgres psql -At -d ${db} -c "${q}"`);
const resRows = sql("catalog", `select count(*)||'/'||count(distinct order_id)||' reserved='||count(*) filter (where status='RESERVED') from reservations where product_id='${prod.id}'`);
const outbox = sql("orders", `select count(*)||' published='||count(published_at) from pso_outbox where created_at > now() - interval '15 minutes'`);
const result = { ordersPlaced: placed.length, http: placed.reduce((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {}), deployExit: code, finalStates: tally, stockLeft: stock, reservationsRows_distinctOrders: resRows, ordersOutboxRecent: outbox, oversold: (tally.CONFIRMED ?? 0) > 8 || stock < 0, durationMs: Date.now() - t0 };
console.log(JSON.stringify(result, null, 1));
mkdirSync(`${FRAMEWORK}/docs/implementation/evidence/ecv`, { recursive: true }); writeFileSync(`${FRAMEWORK}/docs/implementation/evidence/ecv/concurrency-oversell.json`, JSON.stringify(result, null, 2));
