// PSO Commerce - Cloud Validation Playground. Plain ES modules, native fetch and WebSocket, no dependencies, no build step.
// Everything shown comes from the deployed gateway (same origin). Nothing is mocked, simulated or hard-coded.
import { icon } from "./icons.js";
import { $, $$, el, clear, withIcon, fmtTime, fmtMs, statusClass, pretty, copyText, toast } from "./ui.js";
import { send, setPublished, publishedRoutes, fill, paramsOf, MUTATING, Refusal } from "./http.js";
import { createChannels } from "./channels.js";

// ---------------------------------------------------------------- state (memory only)
let token = ""; let tokenClaims = null;
const history = []; const ctx = { customerId: "", productId: "", orderId: "" };
const events = []; const consoleLines = []; let wsInfo = { state: "closed", attempts: 0 }; let inflight = null;
const TOKEN_KEY = "pso-playground-token"; // used ONLY when the user ticks "remember for this tab"; sessionStorage is cleared when the tab closes

function decode(t) { try { const b = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(decodeURIComponent(escape(atob(b)))); } catch { return null; } }
function setToken(t, fromStore = false) { token = t.trim(); tokenClaims = token ? decode(token) : null; if (!fromStore) { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } } if (typeof renderChips === "function") renderChips(); if (typeof renderOverview === "function") renderOverview(); }
const scopesOf = () => (tokenClaims?.scope ?? "").split(/\s+/).filter(Boolean);
const expired = () => tokenClaims?.exp && tokenClaims.exp * 1000 < Date.now();

const channels = createChannels({
  getToken: () => token,
  onState: (s) => { wsInfo = s; renderChips(); renderEvents(); },
  onEvent: (e) => { events.unshift(e); renderEvents(); if (e.channel === `order.${ctx.orderId}`) orderTimeline(`event ${e.type} received over WebSocket`, JSON.stringify(e.payload)); },
  onLine: (l) => { consoleLines.unshift(l); if (consoleLines.length > 300) consoleLines.pop(); renderEvents(); },
});

// ---------------------------------------------------------------- shell
const VIEWS = [["overview", "dashboard", "Overview"], ["customers", "users", "Customers"], ["catalog", "box", "Catalog"], ["orders", "receipt", "Orders"], ["request", "send", "Request"], ["activity", "activity", "Activity"], ["events", "radio", "Events"]];
function show(name) {
  for (const [id] of VIEWS) $(`#view-${id}`).hidden = id !== name;
  $$("#nav button").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  location.hash = name; $("#main").focus({ preventScroll: true });
}
function buildNav() { const nav = $("#nav"); for (const [id, ic, label] of VIEWS) nav.append(el("button", { type: "button", dataset: { view: id }, onclick: () => show(id), "aria-label": label }, icon(ic, 18), el("span", { class: "label", text: label }))); }
function renderChips() {
  $("#brand-icon").replaceChildren(icon("server", 20));
  $("#chip-origin").replaceChildren(icon("lock", 13), document.createTextNode(location.origin));
  const t = $("#chip-token"); t.className = `chip chip-btn ${!token ? "warn" : expired() ? "bad" : "ok"}`; t.onclick = () => { show("overview"); $("#token-input")?.focus(); };
  t.replaceChildren(icon("key", 13), document.createTextNode(!token ? "no token" : expired() ? "token expired" : `token: ${tokenClaims?.sub ?? "set"}`));
  const w = $("#chip-ws"); const ok = wsInfo.state === "connected"; w.className = `chip ${ok ? "ok" : wsInfo.state === "reconnecting" || wsInfo.state === "connecting" ? "warn" : ""}`;
  w.replaceChildren(icon("radio", 13), document.createTextNode(`events: ${wsInfo.state}${wsInfo.state === "reconnecting" ? ` (attempt ${wsInfo.attempts})` : ""}`));
}

// ---------------------------------------------------------------- exchange (the actual request and response, always visible)
function renderExchange(rec) {
  const box = clear($("#exchange")); box.append(el("h2", {}, withIcon("send", "Last request and response")));
  if (!rec) { box.append(el("p", { class: "empty", text: "Nothing sent yet. Every operation on this page shows here the exact request and the exact response." })); return; }
  box.append(el("div", { class: "row" }, el("span", { class: `badge ${rec.method.toLowerCase()}`, text: rec.method }), el("code", { text: rec.path }), rec.response ? el("span", { class: `badge ${statusClass(rec.response.status)}`, text: `${rec.response.status} ${rec.response.statusText}`.trim() }) : el("span", { class: "badge bad", text: rec.error?.kind ?? "failed" }), el("span", { class: "badge muted" }, withIcon("clock", fmtMs(rec.ms), 12))));
  box.append(el("p", { class: "note" + (rec.response && rec.response.status < 400 ? "" : rec.response ? " warn" : " bad") }, icon("info", 16), el("span", { text: `${rec.at.toLocaleTimeString()} - route ${rec.route}; scopes required: ${(rec.scopes ?? []).join(", ") || "none"}` })));
  if (rec.error) box.append(el("div", { class: "note bad" }, icon("alert", 16), el("div", {}, el("strong", { text: rec.error.kind === "network" ? "Network or TLS error" : rec.error.kind }), el("div", { text: rec.error.message }))));
  box.append(el("h3", { text: "Request" }), el("pre", { text: `${rec.method} ${rec.url}\n${Object.entries(rec.request.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}${rec.request.body ? `\n\n${pretty(rec.request.body)}` : ""}` }));
  if (rec.response) {
    box.append(el("h3", { text: "Response body" }), el("pre", { text: rec.response.body ? pretty(rec.response.body) : "(empty body)" }));
    box.append(el("details", {}, el("summary", { text: `Response headers (${Object.keys(rec.response.headers).length})` }), el("pre", { text: Object.entries(rec.response.headers).map(([k, v]) => `${k}: ${v}`).join("\n") })));
  }
}

// ---------------------------------------------------------------- the one place requests are made
async function call(label, r, { quiet = false } = {}) {
  if (!token && !quiet) toast("No token is set: protected routes will answer 401.", "info");
  const ctl = new AbortController(); inflight = ctl;
  let rec; try { rec = await send({ ...r, token, signal: ctl.signal }); } catch (e) { if (e instanceof Refusal) { toast(e.message, "bad"); return null; } throw e; } finally { inflight = null; }
  rec.label = label; history.unshift(rec); if (history.length > 200) history.pop();
  renderExchange(rec); renderActivity(); return rec;
}
const resultNote = (rec, okText) => rec?.response && rec.response.status < 300 ? okText : rec?.response ? `HTTP ${rec.response.status}: ${rec.response.json?.detail ?? rec.response.json?.title ?? "see the response"}` : rec?.error?.message ?? "not sent";

// ---------------------------------------------------------------- forms
function field(name, label, props = {}) { return el("label", {}, label, el("input", { name, autocomplete: "off", spellcheck: "false", ...props })); }
const val = (form, n) => form.elements[n].value.trim();
function formCard(title, ic, note, fields, actions) { return el("form", { class: "card", onsubmit: (e) => e.preventDefault() }, el("h2", {}, withIcon(ic, title)), note ? el("p", { class: "note" }, icon("info", 16), el("span", { text: note })) : null, ...fields, el("div", { class: "toolbar" }, ...actions)); }
function resultBox() { return el("div", { class: "result" }); }
const setResult = (box, kind, text) => { clear(box).append(el("div", { class: `note ${kind === "ok" ? "" : kind}` }, icon(kind === "ok" ? "check" : "alert", 16), el("span", { text }))); };
function useButton(label, key, value, after) { return el("button", { class: "btn ghost", type: "button", onclick: () => { ctx[key] = value; after?.(); toast(`${label} set to ${value}`, "ok"); } }, withIcon("check", `Use as ${label}`, 14)); }

const setLookup = (view, id) => { const i = $(`${view} form:nth-of-type(2) input[name=id]`); if (i) i.value = id; };
function renderCustomers() {
  const root = clear($("#view-customers")); const res = resultBox(); const res2 = resultBox();
  root.append(el("h1", { text: "Customers" }), el("p", { class: "lead", text: "Served by the customers microservice through the PSO gateway. The gateway publishes create and read-by-id; there is no list endpoint, so this page does not offer one." }));
  const create = formCard("Create a customer", "users", "Changes data: POST /customers (scope customers:write).", [field("name", "Name", { value: "Cloud Validation Buyer" }), field("email", "E-mail", { value: `buyer-${Date.now().toString(36)}@example.test` })], [
    el("button", { class: "btn", type: "submit", onclick: async () => { const f = create; const rec = await call("create customer", { method: "POST", path: "/customers", body: JSON.stringify({ name: val(f, "name"), email: val(f, "email") }) }); if (!rec) return; const id = rec.response?.json?.id; setResult(res, id ? "ok" : "warn", id ? `Created ${id}` : resultNote(rec)); if (id) { ctx.customerId = id; setLookup("#view-customers", id); fillOrderForm(); res.append(useButton("customer", "customerId", id, fillOrderForm)); } } }, withIcon("send", "Create customer"))]);
  create.append(res);
  const look = formCard("Look up a customer", "users", "Read only: GET /customers/:id (scope customers:read).", [field("id", "Customer id", { value: ctx.customerId, placeholder: "uuid" })], [
    el("button", { class: "btn", type: "submit", onclick: async () => { const rec = await call("get customer", { method: "GET", path: fill("/customers/:id", { id: val(look, "id") }).path }); if (rec) setResult(res2, rec.response?.status === 200 ? "ok" : "warn", resultNote(rec, `Found ${rec.response?.json?.name} <${rec.response?.json?.email}>`)); } }, withIcon("send", "Get customer"))]);
  look.append(res2); root.append(el("div", { class: "grid" }, create, look));
}
function renderCatalog() {
  const root = clear($("#view-catalog")); const res = resultBox(); const res2 = resultBox();
  root.append(el("h1", { text: "Catalog" }), el("p", { class: "lead", text: "Served by the catalog microservice. Availability is the stock the catalog reports right now; it changes when an order is confirmed." }));
  const create = formCard("Create a product", "box", "Changes data: POST /products (scope catalog:write). Prices are integer cents.", [field("sku", "SKU (max 32)", { value: `SKU-${Date.now().toString(36).toUpperCase()}` }), field("name", "Name", { value: "Validation Widget" }), el("div", { class: "row" }, field("priceCents", "Price (cents)", { type: "number", min: "1", value: "1999" }), field("stock", "Initial stock", { type: "number", min: "0", value: "5" }))], [
    el("button", { class: "btn", type: "submit", onclick: async () => { const rec = await call("create product", { method: "POST", path: "/products", body: JSON.stringify({ sku: val(create, "sku"), name: val(create, "name"), priceCents: Number(val(create, "priceCents")), stock: Number(val(create, "stock")) }) }); if (!rec) return; const id = rec.response?.json?.id; setResult(res, id ? "ok" : "warn", id ? `Created ${id} with stock ${rec.response.json.stock}` : resultNote(rec)); if (id) { ctx.productId = id; setLookup("#view-catalog", id); fillOrderForm(); res.append(useButton("product", "productId", id, fillOrderForm)); } } }, withIcon("send", "Create product"))]);
  create.append(res);
  const look = formCard("Inspect availability", "box", "Read only: GET /products/:id (scope catalog:read).", [field("id", "Product id", { value: ctx.productId, placeholder: "uuid" })], [
    el("button", { class: "btn", type: "submit", onclick: async () => { const rec = await call("get product", { method: "GET", path: fill("/products/:id", { id: val(look, "id") }).path }); const j = rec?.response?.json; if (rec) setResult(res2, rec.response?.status === 200 ? "ok" : "warn", resultNote(rec, `${j?.name}: ${j?.stock} in stock at ${j?.priceCents} cents`)); } }, withIcon("send", "Get product"))]);
  look.append(res2); root.append(el("div", { class: "grid" }, create, look));
}

// ---- orders: place, then observe the asynchronous distributed chain
let timeline = []; let polling = null;
function orderTimeline(label, detail = "") { timeline.push({ at: new Date(), label, detail }); renderTimeline(); }
function renderTimeline() { const box = $("#timeline"); if (!box) return; clear(box); if (!timeline.length) { box.append(el("p", { class: "empty", text: "Place an order to see its path: accepted, decided asynchronously, confirmed, stock updated." })); return; } const ol = el("ol", { class: "timeline" }); for (const t of timeline) ol.append(el("li", {}, el("time", { text: fmtTime(t.at) }), el("div", {}, el("strong", { text: t.label }), t.detail ? el("div", { class: "muted", text: t.detail }) : null))); box.append(ol); }
let orderForm;
function fillOrderForm() { if (!orderForm) return; for (const [n, k] of [["customerId", "customerId"], ["productId", "productId"]]) if (ctx[k]) orderForm.elements[n].value = ctx[k]; }
async function getStock(label) { if (!ctx.productId) return null; const rec = await call(label, { method: "GET", path: fill("/products/:id", { id: ctx.productId }).path }, { quiet: true }); return rec?.response?.json?.stock ?? null; }
async function placeAndObserve() {
  const customerId = val(orderForm, "customerId"), productId = val(orderForm, "productId"), quantity = Number(val(orderForm, "quantity")); ctx.productId = productId; ctx.customerId = customerId; timeline = []; clearInterval(polling);
  const before = await getStock("stock before the order"); orderTimeline("stock before the order", before == null ? "could not be read" : `${before} in stock`);
  const rec = await call("place order", { method: "POST", path: "/orders", body: JSON.stringify({ customerId, productId, quantity }) }); if (!rec) return;
  const o = rec.response?.json; if (!o?.id) { orderTimeline(`order not accepted`, resultNote(rec)); return; }
  ctx.orderId = o.id; $("#order-id").value = o.id; orderTimeline(`order accepted (HTTP ${rec.response.status}), status ${o.status}`, `id ${o.id} in ${fmtMs(rec.ms)}`);
  if (token) { try { channels.subscribe(`order.${o.id}`); } catch (e) { toast(e.message, "bad"); } }
  const t0 = Date.now(); let last = o.status; polling = setInterval(async () => {
    const g = await call("poll order status", { method: "GET", path: fill("/orders/:id", { id: o.id }).path }, { quiet: true }); const s = g?.response?.json?.status;
    if (s && s !== last) { last = s; orderTimeline(`status changed to ${s}`, `${((Date.now() - t0) / 1000).toFixed(1)} s after placing the order (read through the gateway)`); }
    if ((s && s !== "PENDING") || Date.now() - t0 > 60000) { clearInterval(polling); if (!s || s === "PENDING") orderTimeline("still PENDING after 60 s", "no decision was observed"); else { const after = await getStock("stock after the order"); orderTimeline("stock after the order", after == null ? "could not be read" : `${after} in stock${before != null ? ` (was ${before}, ordered ${quantity})` : ""}`); } }
  }, 1000);
}
function renderOrders() {
  const root = clear($("#view-orders")); const res = resultBox();
  root.append(el("h1", { text: "Orders" }), el("p", { class: "lead", text: "Placing an order is accepted at once (HTTP 202, PENDING). The decision then travels through the outbox and the message broker to the catalog and back; this page observes it through real reads and the real WebSocket channel." }));
  orderForm = formCard("Place an order", "receipt", "Changes data: POST /orders (scope orders:write). Ids default to the last customer and product created on this page.", [field("customerId", "Customer id", { value: ctx.customerId, placeholder: "uuid" }), field("productId", "Product id", { value: ctx.productId, placeholder: "uuid" }), field("quantity", "Quantity", { type: "number", min: "1", value: "1" })], [
    el("button", { class: "btn", type: "submit", onclick: placeAndObserve }, withIcon("send", "Place order and observe"))]);
  orderForm.append(el("div", { class: "note" }, icon("info", 16), el("span", { text: "This explicit action sends: read stock, place the order, then read the order every second until it is decided, and read stock again. The WebSocket events appear in Events." })));
  const inspect = el("div", { class: "card" }, el("h2", {}, withIcon("receipt", "Inspect an order")), el("label", {}, "Order id", el("input", { id: "order-id", value: ctx.orderId, placeholder: "uuid", autocomplete: "off" })), el("div", { class: "toolbar" },
    el("button", { class: "btn ghost", type: "button", onclick: async () => { ctx.orderId = $("#order-id").value.trim(); const r = await call("get order", { method: "GET", path: fill("/orders/:id", { id: ctx.orderId }).path }); if (r) orderTimeline(`order read: ${r.response?.json?.status ?? "HTTP " + (r.response?.status ?? "error")}`); } }, withIcon("refresh", "Order status")),
    el("button", { class: "btn ghost", type: "button", onclick: async () => { ctx.orderId = $("#order-id").value.trim(); const r = await call("composed gateway view", { method: "GET", path: fill("/overview/orders/:id", { id: ctx.orderId }).path }); const j = r?.response?.json; if (r) orderTimeline("composed view from three services", j ? `order ${j.order?.status}; customer ${j.customer?.name}; product ${j.product?.name}, ${j.product?.stockLeft} left; total ${j.totalCents} cents` : resultNote(r)); } }, withIcon("server", "Composed gateway view")),
    el("button", { class: "btn ghost", type: "button", onclick: async () => { const s = await getStock("verify stock"); orderTimeline("stock verified", s == null ? "set a product id first" : `${s} in stock`); } }, withIcon("box", "Verify stock"))));
  root.append(el("div", { class: "grid" }, orderForm, inspect), el("div", { class: "card" }, el("h2", {}, withIcon("clock", "What happened, in order")), el("div", { id: "timeline" }))); renderTimeline();
}

// ---------------------------------------------------------------- generic request
const reqState = { rows: { query: [["", ""]], headers: [["", ""]] } };
function kvRows(kind) {
  const wrap = el("div", { class: "kvrows" }); const draw = () => { clear(wrap); reqState.rows[kind].forEach((pair, i) => wrap.append(el("div", { class: "kvrow" }, el("input", { value: pair[0], placeholder: kind === "query" ? "name" : "Header-Name", "aria-label": `${kind} name ${i + 1}`, oninput: (e) => { pair[0] = e.target.value; } }), el("input", { value: pair[1], placeholder: "value", "aria-label": `${kind} value ${i + 1}`, oninput: (e) => { pair[1] = e.target.value; } }), el("button", { class: "btn ghost", type: "button", "aria-label": "Remove", onclick: () => { reqState.rows[kind].splice(i, 1); if (!reqState.rows[kind].length) reqState.rows[kind].push(["", ""]); draw(); } }, icon("x", 14))))); wrap.append(el("button", { class: "btn ghost", type: "button", onclick: () => { reqState.rows[kind].push(["", ""]); draw(); } }, withIcon("check", `Add ${kind === "query" ? "query parameter" : "header"}`, 14))); }; draw(); return wrap;
}
function renderRequest() {
  const root = clear($("#view-request")); const routes = publishedRoutes();
  root.append(el("h1", { text: "Request" }), el("p", { class: "lead", text: "Send one HTTP request to this gateway. Only routes the deployed release publishes can be chosen, and requests can only go to this origin." }));
  if (!routes.length) { root.append(el("div", { class: "note bad" }, icon("alert", 16), el("span", { text: "The release published no route metadata, so nothing can be sent from here." }))); return; }
  const methods = [...new Set(routes.map((r) => r.method))]; const f = el("form", { class: "card", onsubmit: (e) => e.preventDefault() });
  const mSel = el("select", { name: "method", "aria-label": "HTTP method" }, methods.map((m) => el("option", { value: m, text: m })));
  const eSel = el("select", { name: "endpoint", "aria-label": "Published endpoint" }); const params = el("div", { class: "row" }); const body = el("textarea", { name: "body", placeholder: '{ "example": "json" }', spellcheck: "false", "aria-label": "JSON body" });
  const confirm = el("label", { class: "check", hidden: true }, el("input", { type: "checkbox", name: "confirm" }), "I understand this request changes data on the deployed system");
  const info = el("div", { class: "note" }); const sendBtn = el("button", { class: "btn", type: "submit" }, withIcon("send", "Send")); const cancelBtn = el("button", { class: "btn danger", type: "button", disabled: true, onclick: () => inflight?.abort() }, withIcon("stop", "Cancel"));
  const syncEndpoints = () => { clear(eSel); for (const r of routes.filter((x) => x.method === mSel.value)) eSel.append(el("option", { value: r.path, text: r.path })); syncParams(); };
  const route = () => routes.find((r) => r.method === mSel.value && r.path === eSel.value);
  const syncParams = () => { const r = route(); clear(params); for (const p of paramsOf(r.path)) params.append(el("label", {}, `Path parameter :${p}`, el("input", { name: `p_${p}`, "aria-label": `Path parameter ${p}`, autocomplete: "off", value: p === "id" ? (r.path.startsWith("/customers") ? ctx.customerId : r.path.startsWith("/products") ? ctx.productId : ctx.orderId) : "" }))); confirm.hidden = !MUTATING.has(r.method); body.disabled = r.method === "GET"; clear(info).append(icon("info", 16), el("span", { text: `Scopes required: ${r.scopes.join(", ") || "none"}. Handled by: ${[r.service, ...r.services].filter(Boolean).join(", ") || "gateway"}.` })); };
  mSel.onchange = syncEndpoints; eSel.onchange = syncParams;
  f.append(el("h2", {}, withIcon("send", "Compose")), el("div", { class: "row" }, el("label", {}, "Method", mSel), el("label", {}, "Endpoint", eSel)), info, params, el("h3", { text: "Query parameters" }), kvRows("query"), el("h3", { text: "Headers" }), kvRows("headers"), el("p", { class: "note" }, icon("key", 16), el("span", { text: token ? `The token set above is sent as a bearer credential (${scopesOf().length} scopes).` : "No token set: protected routes will answer 401." })), el("h3", { text: "JSON body" }), body, confirm, el("div", { class: "toolbar" }, sendBtn, cancelBtn));
  f.onsubmit = async (e) => { e.preventDefault(); const r = route(); const p = {}; for (const n of paramsOf(r.path)) p[n] = f.elements[`p_${n}`].value; const { path, missing } = fill(r.path, p); if (missing.length) return toast(`Fill the path parameter: ${missing.join(", ")}`, "bad"); if (MUTATING.has(r.method) && !f.elements.confirm.checked) return toast("Tick the confirmation: this request changes data.", "bad");
    const q = Object.fromEntries(reqState.rows.query.filter((x) => x[0].trim())); const h = Object.fromEntries(reqState.rows.headers.filter((x) => x[0].trim()));
    sendBtn.disabled = true; cancelBtn.disabled = false; try { await call("manual request", { method: r.method, path, query: q, headers: h, ...(body.value.trim() && r.method !== "GET" ? { body: body.value } : {}) }); } finally { sendBtn.disabled = false; cancelBtn.disabled = true; f.elements.confirm.checked = false; } };
  root.append(f); syncEndpoints();
}

// ---------------------------------------------------------------- activity
function renderActivity() {
  const root = clear($("#view-activity")); root.append(el("h1", { text: "Request activity" }), el("p", { class: "lead", text: `Requests sent from this browser tab (${history.length}). Kept in memory only: closing the tab discards them. Tokens are never recorded.` }));
  if (!history.length) { root.append(el("p", { class: "empty", text: "No requests yet." })); return; }
  const t = el("table", {}, el("thead", {}, el("tr", {}, ["Time", "Action", "Request", "Result", "Duration"].map((h) => el("th", { text: h })))), el("tbody", {}, history.map((r) => el("tr", { class: "click", tabindex: "0", onclick: () => renderExchange(r), onkeydown: (e) => { if (e.key === "Enter") renderExchange(r); } }, el("td", { text: r.at.toLocaleTimeString() }), el("td", { text: r.label }), el("td", {}, el("span", { class: `badge ${r.method.toLowerCase()}`, text: r.method }), " ", el("code", { text: r.path })), el("td", {}, r.response ? el("span", { class: `badge ${statusClass(r.response.status)}`, text: String(r.response.status) }) : el("span", { class: "badge bad", text: r.error?.kind })), el("td", { text: fmtMs(r.ms) })))));
  root.append(el("div", { class: "card" }, t), el("div", { class: "toolbar" }, el("button", { class: "btn ghost", type: "button", onclick: () => { history.length = 0; renderActivity(); renderExchange(null); } }, withIcon("trash", "Clear activity"))));
}

// ---------------------------------------------------------------- events (WebSocket)
let channelInput;
function renderEvents() {
  const root = $("#view-events"); if (!root || (channelInput && document.activeElement === channelInput)) return; const keep = channelInput?.value ?? ctx.orderId; clear(root);
  root.append(el("h1", { text: "Events" }), el("p", { class: "lead", text: "Live events from the gateway's WebSocket (PSO Channels). The only channel the deployed gateway declares is order.<order id>; subscription needs the orders:read scope. Every line below was received from the server." }));
  channelInput = el("input", { placeholder: "order id (uuid)", value: keep, "aria-label": "Order id to subscribe", autocomplete: "off" });
  const connected = wsInfo.state === "connected";
  root.append(el("div", { class: "card" }, el("div", { class: "row" }, el("div", { class: "stat" }, el("span", { class: "k", text: "Connection" }), el("span", { class: "v", text: wsInfo.state })), el("div", { class: "stat" }, el("span", { class: "k", text: "Reconnection attempts" }), el("span", { class: "v", text: String(wsInfo.attempts ?? 0) })), el("div", { class: "stat" }, el("span", { class: "k", text: "Subscribed" }), el("span", { class: "v", text: channels.channels().join(", ") || "none" }))),
    el("div", { class: "toolbar" }, el("button", { class: "btn", type: "button", disabled: wsInfo.state !== "closed", onclick: () => { if (!token) return toast("Set a token first.", "bad"); channels.connect(); } }, withIcon("radio", "Connect")), el("button", { class: "btn ghost", type: "button", disabled: wsInfo.state === "closed", onclick: () => channels.disconnect() }, withIcon("stop", "Disconnect")), el("button", { class: "btn ghost", type: "button", disabled: !connected, onclick: () => channels.reauthenticate() }, withIcon("key", "Re-authenticate"))),
    el("div", { class: "row", style: null }, el("label", {}, "Subscribe to an order's channel", channelInput), el("button", { class: "btn", type: "button", onclick: () => { try { if (!token) return toast("Set a token first.", "bad"); channels.subscribe(`order.${channelInput.value.trim()}`); renderEvents(); } catch (e) { toast(e.message, "bad"); } } }, withIcon("check", "Subscribe")))));
  const log = el("div", { class: "console", role: "log", "aria-live": "off" }); const rows = [...consoleLines.map((l) => ({ ...l, ev: false })), ...events.map((e) => ({ at: e.at, kind: "event", ev: e }))].sort((a, b) => b.at - a.at).slice(0, 200);
  if (!rows.length) log.append(el("p", { class: "empty", text: "No connection activity yet." }));
  for (const r of rows) log.append(r.ev ? el("div", { class: "ln event" }, el("time", { text: fmtTime(r.at) }), el("strong", { text: r.ev.type }), ` on ${r.ev.channel}`, el("div", { text: `payload ${JSON.stringify(r.ev.payload)}` }), el("div", { class: "muted", text: `correlation ${r.ev.correlationId ?? "(none)"} - event ${r.ev.eventId} - server time ${r.ev.ts}` })) : el("div", { class: `ln ${r.kind}` }, el("time", { text: fmtTime(r.at) }), r.text));
  root.append(el("div", { class: "card" }, el("h2", {}, withIcon("radio", `Console (${events.length} event${events.length === 1 ? "" : "s"})`)), log, el("div", { class: "toolbar" }, el("button", { class: "btn ghost", type: "button", onclick: () => { events.length = 0; consoleLines.length = 0; renderEvents(); } }, withIcon("trash", "Clear console")))));
}

// ---------------------------------------------------------------- overview and authentication
let readiness = null;
async function probeReadiness() { const t0 = performance.now(); try { const r = await fetch("/health/ready", { cache: "no-store", credentials: "omit" }); const text = await r.text(); readiness = { ok: r.ok, status: r.status, ms: performance.now() - t0, text, at: new Date() }; } catch { readiness = { ok: false, status: 0, ms: performance.now() - t0, text: "the gateway did not answer (unreachable, reset, or certificate not trusted)", at: new Date() }; } renderOverview(); }
function renderOverview() {
  const root = $("#view-overview"); if (!root) return; const keepToken = $("#token-input")?.value ?? ""; clear(root); const routes = publishedRoutes();
  root.append(el("h1", { text: "PSO Commerce - Cloud Validation Playground" }), el("p", { class: "lead", text: "A browser client for the PSO Commerce application running on the validation server. It talks to the real gateway on this origin; the gateway talks to the customers, catalog and orders microservices. Nothing on this page is simulated." }));
  root.append(el("div", { class: "grid" },
    el("div", { class: "card" }, el("h2", {}, withIcon("server", "Gateway")), el("div", { class: "stat" }, el("span", { class: "k", text: "Origin" }), el("span", { class: "v", text: location.origin })), el("div", { class: "stat" }, el("span", { class: "k", text: "Readiness (GET /health/ready)" }), el("span", { class: "v" }, readiness ? el("span", { class: `badge ${readiness.ok ? "ok" : "bad"}`, text: readiness.status ? `HTTP ${readiness.status}` : "no answer" }) : "checking...", readiness ? ` ${fmtMs(readiness.ms)} at ${readiness.at.toLocaleTimeString()}` : "")), readiness ? el("pre", { text: pretty(readiness.text).slice(0, 600) }) : null, el("div", { class: "toolbar" }, el("button", { class: "btn ghost", type: "button", onclick: probeReadiness }, withIcon("refresh", "Check again")))),
    el("div", { class: "card" }, el("h2", {}, withIcon("key", "Authentication")), tokenClaims ? el("dl", { class: "kv" }, el("dt", { text: "subject" }), el("dd", { text: tokenClaims.sub ?? "?" }), el("dt", { text: "issuer" }), el("dd", { text: tokenClaims.iss ?? "?" }), el("dt", { text: "scopes" }), el("dd", { text: scopesOf().join(" ") || "(none)" }), el("dt", { text: "expires" }), el("dd", { text: tokenClaims.exp ? `${new Date(tokenClaims.exp * 1000).toLocaleTimeString()}${expired() ? " (expired)" : ""}` : "no expiry" })) : el("p", { class: "note warn" }, icon("alert", 16), el("span", { text: token ? "The token is not a readable JWT; the server will still judge it." : "No token set." })),
      el("label", {}, "Bearer token", el("input", { id: "token-input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "paste a short-lived access token", value: keepToken })),
      el("label", { class: "check" }, el("input", { id: "remember", type: "checkbox" }), "Remember it for this tab only (session storage)"),
      el("div", { class: "toolbar" }, el("button", { class: "btn", type: "button", onclick: () => { const t = $("#token-input").value; const keep = $("#remember")?.checked; $("#token-input").value = ""; setToken(t); if (keep && t.trim()) { try { sessionStorage.setItem(TOKEN_KEY, t.trim()); } catch { /* ignore */ } } toast(t.trim() ? "Token set (memory only)." : "Token cleared.", "ok"); } }, withIcon("check", "Use token")), el("button", { class: "btn ghost", type: "button", onclick: () => { setToken(""); channels.disconnect(); toast("Token cleared and the event connection closed.", "ok"); } }, withIcon("x", "Clear")),
        el("button", { class: "btn ghost", type: "button", onclick: () => copyText('node dev-token.mjs "customers:read customers:write catalog:read catalog:write orders:read orders:write"').then(() => toast("Command copied.", "ok")).catch(() => toast("Copy failed; select the text manually.", "bad")) }, withIcon("copy", "Copy token command"))),
      el("p", { class: "note" }, icon("info", 16), el("span", {}, "The token is issued by this deployment's identity provider key, which stays on the owner's machine. Mint one there (from the fixtures/pso-cloud-validation directory): ", el("code", { text: 'node dev-token.mjs "customers:read orders:read ..."' }), ". It is kept in memory, sent only to this origin, and discards when the tab closes."))),
    el("div", { class: "card" }, el("h2", {}, withIcon("radio", "Events")), el("div", { class: "stat" }, el("span", { class: "k", text: "WebSocket" }), el("span", { class: "v", text: wsInfo.state })), el("div", { class: "stat" }, el("span", { class: "k", text: "Events received" }), el("span", { class: "v", text: String(events.length) })), el("div", { class: "stat" }, el("span", { class: "k", text: "Requests sent in this tab" }), el("span", { class: "v", text: String(history.length) })))));
  root.append(el("div", { class: "card" }, el("h2", {}, withIcon("activity", `Published API (${routes.length} routes, from the deployed release's pso-release.json)`)), routes.length ? el("table", {}, el("thead", {}, el("tr", {}, ["Method", "Path", "Scopes", "Service"].map((h) => el("th", { text: h })))), el("tbody", {}, routes.map((r) => el("tr", {}, el("td", {}, el("span", { class: `badge ${r.method.toLowerCase()}`, text: r.method })), el("td", {}, el("code", { text: r.path })), el("td", { text: r.scopes.join(", ") || "-" }), el("td", { text: [r.service, ...r.services].filter(Boolean).join(", ") || "gateway" }))))) : el("p", { class: "empty", text: "The release carries no route metadata." })));
}

// ---------------------------------------------------------------- start
async function start() {
  try { const t = sessionStorage.getItem(TOKEN_KEY); if (t) setToken(t, true); } catch { /* storage unavailable */ }
  buildNav(); renderChips(); renderExchange(null);
  try { const r = await fetch("/playground/routes.json", { cache: "no-store", credentials: "omit" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); setPublished((await r.json()).routes); } catch (e) { toast(`Could not load the published routes: ${e.message}`, "bad"); setPublished([]); }
  renderOverview(); renderCustomers(); renderCatalog(); renderOrders(); renderRequest(); renderActivity(); renderEvents();
  show(VIEWS.some(([v]) => v === location.hash.slice(1)) ? location.hash.slice(1) : "overview"); probeReadiness();
  window.addEventListener("beforeunload", () => channels.disconnect());
}
start();
