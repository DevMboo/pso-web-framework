// PSO Commerce acceptance checks: black-box requests through the gateway of the running Compose deployment.
// Run from the workspace root:  node acceptance.mjs   (PSO_CLI = path of pso.js, COMPOSE = the docker compose prefix)
import { execFileSync } from "node:child_process";

const PSO = process.env.PSO_CLI;
const DC = ["compose", "-p", "psocommerce-fcv", "-f", "docker-compose.yml", "-f", "docker-compose.idp.yml", "-f", "docker-compose.override.yml"];
const BASE = "http://127.0.0.1:3000";
const run = Date.now().toString(36);
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`); };
const token = (scopes, sub = "dev-user") => JSON.parse(execFileSync("node", [PSO, "idp:dev", "token", "--sub", sub, "--scopes", scopes, "--json"], { encoding: "utf8" })).token;
const docker = (...a) => execFileSync("docker", [...DC, ...a], { stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, { tok, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}
const d = (r) => `${r.status} ${r.text.slice(0, 140)}`;

const all = token("customers:read,customers:write,catalog:read,catalog:write,orders:read,orders:write", "alice");
const readOnly = token("customers:read");

// --- authentication and authorization
check("no token -> 401", (await call("GET", "/customers")).status === 401);
check("token without the scope -> 403", (await call("POST", "/customers", { tok: readOnly, body: { name: "No Scope", email: `x-${run}@example.test` } })).status === 403);
const forged = all.slice(0, -4) + "AAAA";
check("token with a broken signature -> 401", (await call("GET", "/customers", { tok: forged })).status === 401);

// --- customers (PostgreSQL)
const email = `ana-${run}@example.test`;
const c = await call("POST", "/customers", { tok: all, body: { name: "Ana Example", email } });
check("create customer", c.status >= 200 && c.status < 300 && c.json?.id && c.json.status === "ACTIVE", d(c));
const cid = c.json?.id;
const dup = await call("POST", "/customers", { tok: all, body: { name: "Other", email: email.toUpperCase() } });
check("duplicate e-mail -> 409", dup.status === 409, d(dup));
const bad = await call("POST", "/customers", { tok: all, body: { name: "A", email: "not-an-email" } });
check("invalid body refused by the gateway DTO -> 400", bad.status === 400, d(bad));
check("get customer", (await call("GET", `/customers/${cid}`, { tok: all })).json?.email === email);
check("list customers contains it", (await call("GET", "/customers", { tok: all })).json?.some?.((x) => x.id === cid));
const upd = await call("PUT", `/customers/${cid}`, { tok: all, body: { name: "Ana Updated", email } });
check("update customer", upd.json?.name === "Ana Updated", d(upd));
check("unknown customer -> 404", (await call("GET", "/customers/does-not-exist", { tok: all })).status === 404);

// --- catalog (PostgreSQL, integer cents)
const p = await call("POST", "/products", { tok: all, body: { sku: `SKU-${run}`, name: "Keyboard", priceCents: 12990, stock: 5 } });
check("create product (price in integer cents, available)", p.json?.priceCents === 12990 && p.json?.available === true, d(p));
const pid = p.json?.id;
const st = await call("PATCH", `/products/${pid}/stock`, { tok: all, body: { stock: 3 } });
check("change stock", st.json?.stock === 3, d(st));

// --- orders: service-to-service HTTPS, total, transactional outbox, RabbitMQ, catalog consumer
const o = await call("POST", "/orders", { tok: all, body: { customerId: cid, productId: pid, quantity: 2 } });
check("place order: total = 2 x 12990, status PLACED, author = token subject", o.json?.totalCents === 25980 && o.json?.status === "PLACED" && o.json?.createdBy === "alice", d(o));
const oid = o.json?.id;
check("get order", (await call("GET", `/orders/${oid}`, { tok: all })).json?.id === oid);
let stock;
for (let i = 0; i < 40 && stock !== 1; i++) { await sleep(500); stock = (await call("GET", `/products/${pid}`, { tok: all })).json?.stock; }
check("outbox -> RabbitMQ -> catalog: stock 3 -> 1", stock === 1, `stock ${stock}`);
const many = await call("POST", "/orders", { tok: all, body: { customerId: cid, productId: pid, quantity: 9 } });
check("insufficient stock -> 409", many.status === 409, d(many));
const ghost = await call("POST", "/orders", { tok: all, body: { customerId: "does-not-exist", productId: pid, quantity: 1 } });
check("unknown customer in an order -> 422", ghost.status === 422, d(ghost));
await call("PATCH", `/customers/${cid}/status`, { tok: all, body: { status: "SUSPENDED" } });
const susp = await call("POST", "/orders", { tok: all, body: { customerId: cid, productId: pid, quantity: 1 } });
check("suspended customer cannot order -> 422", susp.status === 422, d(susp));
await call("PATCH", `/customers/${cid}/status`, { tok: all, body: { status: "ACTIVE" } });

// --- composition in the orchestrator (UpstreamClient: customers + orders + catalog)
const s = await call("GET", `/customers/${cid}/summary`, { tok: all });
check("summary composes three services", s.status === 200 && s.json?.customer?.id === cid && s.json?.orderCount === 1 && s.json?.totalCents === 25980 && s.json?.orders?.[0]?.product?.name === "Keyboard", d(s));
const s404 = await call("GET", "/customers/does-not-exist/summary", { tok: all });
check("summary of an unknown customer -> 404 problem", s404.status === 404, d(s404));
const sNoScope = await call("GET", `/customers/${cid}/summary`, { tok: readOnly });
check("summary without orders:read -> 403", sNoScope.status === 403, d(sNoScope));

// --- undeclared decorated action
const und = await call("GET", "/products/internal/debug", { tok: all });
check("decorated action missing from ROUTES.pso.ts is not reachable", und.status !== 200 && !und.text.includes("leaked"), d(und));

// --- one upstream unavailable
docker("stop", "catalog");
const down = await call("GET", `/customers/${cid}/summary`, { tok: all });
check("catalog stopped: summary answers a sanitized 502/503/504 problem", [502, 503, 504].includes(down.status) && !/ECONN|catalog:8082|stack/i.test(down.text), d(down));
check("catalog stopped: customers still answers", (await call("GET", `/customers/${cid}`, { tok: all })).status === 200);
docker("start", "catalog");
let back = false;
for (let i = 0; i < 90 && !back; i++) { await sleep(2000); back = (await call("GET", `/products/${pid}`, { tok: all })).status === 200; }
check("catalog started again: products answers", back);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
