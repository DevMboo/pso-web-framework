import { WORKSPACE, FRAMEWORK } from "./config.mjs";
// The commerce workflow against the validation server (strict TLS, private CA). Output is a sanitized summary.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { call, tokenFor } from "./ecv.mjs";
const require = createRequire(`${FRAMEWORK}/package.json`);
const WS = require("ws");
const { createPsoChannels } = await import(`file:///${FRAMEWORK}/packages/channels-client/dist/index.js`);
const CA = readFileSync(`${WORKSPACE}/.tls/ca.pem`);
class CAWebSocket extends WS { constructor(url, protocols) { super(url, protocols, { ca: CA, rejectUnauthorized: true }); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = tokenFor("customers:read customers:write catalog:read catalog:write orders:read orders:write");
const out = { steps: [] }; const step = (name, ok, detail) => { out.steps.push({ name, ok, ...detail }); console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(detail ?? {}).slice(0, 220)); };

const t0 = Date.now();
const customer = await call("POST", "/customers", { token: all, body: { name: "Validation Buyer", email: `buyer-${Date.now()}@example.test` } });
step("create customer", customer.status === 201, { status: customer.status, ms: customer.ms });
const product = await call("POST", "/products", { token: all, body: { sku: `SKU-${Date.now()}`, name: "Validation Widget", priceCents: 1999, stock: 5 } });
step("create product (stock 5)", product.status === 201, { status: product.status, ms: product.ms });
if (!customer.json?.id || !product.json?.id) process.exit(1);

// order id is only known after POST, so subscribe to a WILDCARD-free channel after placing the order, racing the event: place first, subscribe right after;
// the notification is DURABLE so a late subscriber still gets the event only if it is delivered after subscription: measure honestly.
const channels = createPsoChannels({ url: "wss://127.0.0.1:18443/channels", getToken: () => all, WebSocketImpl: CAWebSocket });
const order = await call("POST", "/orders", { token: all, body: { customerId: customer.json.id, productId: product.json.id, quantity: 2 } });
step("place order (202, persisted PENDING)", order.status === 202 && order.json?.status === "PENDING", { status: order.status, orderStatus: order.json?.status, ms: order.ms });
const oid = order.json.id;
const events = [];
const sub = channels.subscribe(`order.${oid}`, { onEvent: (e) => events.push({ type: e.type, payload: e.payload, at: Date.now() - t0 }) });
// poll the state through the orchestrator until the asynchronous chain completes
let final; for (let i = 0; i < 60; i++) { await sleep(500); const g = await call("GET", `/orders/${oid}`, { token: all }); if (g.json?.status && g.json.status !== "PENDING") { final = g; break; } }
step("order decided asynchronously (outbox -> RabbitMQ -> catalog -> outbox -> RabbitMQ -> orders)", final?.json?.status === "CONFIRMED", { status: final?.json?.status, afterMs: Date.now() - t0 });
const stock = await call("GET", `/products/${product.json.id}`, { token: all });
step("inventory updated (5 - 2 = 3)", stock.json?.stock === 3, { stock: stock.json?.stock });
const overview = await call("GET", `/overview/orders/${oid}`, { token: all });
step("orchestrator composes state from three services", overview.status === 200 && overview.json?.order?.status === "CONFIRMED", { status: overview.status, order: overview.json?.order?.status, customer: overview.json?.customer?.name, stockLeft: overview.json?.product?.stockLeft, totalCents: overview.json?.totalCents });
await sleep(1500);
out.notificationsReceived = events.length;
step("real-time notification delivered over WebSocket (wss, strict TLS)", events.some((e) => e.type === "order.updated"), { received: events.map((e) => ({ type: e.type, status: e.payload?.status })), note: events.length ? "" : "subscribed after the event was published: see the dedicated ordering test" });
try { sub.unsubscribe?.(); channels.close?.(); } catch { /* closing */ }
out.ids = { orderId: oid, customerId: customer.json.id, productId: product.json.id }; out.totalMs = Date.now() - t0;
console.log(JSON.stringify({ ok: out.steps.every((s) => s.ok), ids: out.ids, totalMs: out.totalMs }));
process.exit(0);
