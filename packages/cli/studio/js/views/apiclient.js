// API Client: real requests to the workspace's own endpoints, executed by the Studio server (see studio-apiclient.ts for the boundary).
// Endpoints are discovered from ROUTES.pso.ts and the services' contracts; targets come from the declared topology, never from a typed URL.
import { api } from "../api.js";
import { el, icon, Badge, Button, MethodBadge, Panel, toast } from "../ui.js";
import { Page, code } from "./common.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const envKey = "pso-studio-infra-env";
const getEnv = () => { try { return sessionStorage.getItem(envKey) ?? ""; } catch { return ""; } };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Editable key/value rows (query, headers, form fields, variables). */
function pairs(label, initial = []) {
  const box = el("div", { class: "stack kv-editor" });
  const add = (k = "", v = "") => {
    const row = el("div", { class: "row" }, el("input", { type: "text", placeholder: "name", "aria-label": `${label} name`, value: k, spellcheck: "false" }), el("input", { type: "text", placeholder: "value", "aria-label": `${label} value`, value: v, spellcheck: "false" }), el("button", { class: "icon-btn", type: "button", "aria-label": `Remove ${label} row`, onclick: () => row.remove() }, icon("x")));
    box.insertBefore(row, addBtn);
  };
  const addBtn = Button({ label: `Add ${label}`, iconName: "plus", variant: "ghost", onclick: () => add() });
  box.append(addBtn);
  initial.forEach(([k, v]) => add(k, v));
  return { node: box, read: () => [...box.querySelectorAll(".row")].map((r) => { const [a, b] = r.querySelectorAll("input"); return [a.value.trim(), b.value]; }).filter(([k]) => k), set: (list) => { box.querySelectorAll(".row").forEach((r) => r.remove()); list.forEach(([k, v]) => add(k, v)); } };
}

export async function apiClientView(ctx) {
  const env = getEnv() || undefined;
  const [t, hist, coll] = await Promise.all([api.client.targets(env), api.client.history(), api.client.collections()]);
  let infra = null; try { infra = await api.infra(env); } catch { /* no contract */ }
  const users = infra?.topology?.identity?.users ?? [];
  if (t.error) return Page({ title: "API Client" }, el("p", { class: "callout warn" }, icon("triangle-alert"), t.error));

  // ---- builder
  const target = el("select", { "aria-label": "Target" }, t.targets.map((x) => el("option", { value: x.id, ...(x.refused ? { disabled: true, title: x.refused } : {}) }, `${x.label}${x.refused ? " (needs a client certificate)" : ""}`)));
  const method = el("select", { "aria-label": "Method" }, METHODS.map((m) => el("option", { value: m }, m)));
  const path = el("input", { type: "text", value: "/health/ready", "aria-label": "Path", spellcheck: "false", class: "grow mono", oninput: () => drawParams() });
  const paramsBox = el("div", { class: "row wrap" });
  const params = {};
  const drawParams = () => { const names = [...path.value.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]); paramsBox.replaceChildren(...names.map((n) => el("label", { class: "field" }, el("span", { class: "muted small" }, `:${n}`), (params[n] ??= el("input", { type: "text", "aria-label": `Path parameter ${n}`, spellcheck: "false" }))))); };
  const query = pairs("query parameter"), headers = pairs("header", [["accept", "application/json"]]);
  const authKind = el("select", { "aria-label": "Authentication" }, el("option", { value: "none" }, "No authentication"), el("option", { value: "bearer" }, "Bearer token"), ...(users.length ? [el("option", { value: "dev-user" }, "Development user (token from the identity provider)")] : []));
  const token = el("input", { type: "password", placeholder: "token or {{token}}", "aria-label": "Bearer token", autocomplete: "off", spellcheck: "false" });
  const user = el("select", { "aria-label": "Development user" }, users.map((u) => el("option", { value: u.username }, `${u.username} (${u.scopes.join(", ")})`)));
  const authExtra = el("div", { class: "row wrap" });
  const drawAuth = () => authExtra.replaceChildren(...(authKind.value === "bearer" ? [token] : authKind.value === "dev-user" ? [user] : []));
  authKind.addEventListener("change", drawAuth);
  const bodyKind = el("select", { "aria-label": "Body" }, ["none", "json", "raw", "form", "multipart"].map((k) => el("option", { value: k }, k === "multipart" ? "form-data (files)" : k)));
  const bodyText = el("textarea", { rows: 8, class: "mono", spellcheck: "false", "aria-label": "Body", placeholder: '{ "id": "p-1" }' });
  const rawType = el("input", { type: "text", value: "text/plain; charset=utf-8", "aria-label": "Content type", spellcheck: "false" });
  const formFields = pairs("field");
  const files = el("input", { type: "file", multiple: true, "aria-label": "Files" });
  const fileField = el("input", { type: "text", value: "file", "aria-label": "File field name", spellcheck: "false" });
  const bodyBox = el("div", { class: "stack" });
  const drawBody = () => bodyBox.replaceChildren(...(bodyKind.value === "json" ? [bodyText] : bodyKind.value === "raw" ? [rawType, bodyText] : bodyKind.value === "form" ? [formFields.node] : bodyKind.value === "multipart" ? [formFields.node, el("div", { class: "row wrap" }, el("label", { class: "field" }, el("span", { class: "muted small" }, "file field"), fileField), files)] : []));
  bodyKind.addEventListener("change", drawBody);
  const timeout = el("input", { type: "number", min: "1", max: "120", value: "30", "aria-label": "Timeout in seconds", class: "narrow-num" });
  const vars = pairs("variable", coll.variables ?? []);
  const subst = (s) => s.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (m, k) => { const v = vars.read().find(([n]) => n === k); return v ? v[1] : m; });

  // ---- response
  const resp = el("div", { class: "stack", "aria-live": "polite" }, el("p", { class: "muted" }, "Send a request to see the response."));
  let inflight = null;
  const sendBtn = Button({ label: "Send", iconName: "send", onclick: () => send() });
  const cancelBtn = Button({ label: "Cancel", iconName: "square", variant: "ghost", disabled: true, onclick: async () => { if (inflight) { await api.client.cancel(inflight).catch(() => {}); toast("cancellation requested"); } } });
  const readFiles = () => Promise.all([...files.files].map((f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ field: fileField.value || "file", filename: f.name, contentType: f.type || "application/octet-stream", base64: String(r.result).split(",")[1] ?? "" }); r.onerror = () => rej(r.error); r.readAsDataURL(f); })));
  async function send() {
    let p = subst(path.value.trim());
    for (const [n, inp] of Object.entries(params)) if (p.includes(`:${n}`)) { if (!inp.value) { toast(`path parameter :${n} is empty`, "bad"); return; } p = p.replace(`:${n}`, encodeURIComponent(subst(inp.value))); }
    const body = bodyKind.value === "none" ? { kind: "none" } : bodyKind.value === "json" ? { kind: "json", text: subst(bodyText.value) } : bodyKind.value === "raw" ? { kind: "raw", text: subst(bodyText.value), contentType: rawType.value } : bodyKind.value === "form" ? { kind: "form", fields: formFields.read().map(([k, v]) => [k, subst(v)]) } : { kind: "multipart", fields: formFields.read().map(([k, v]) => [k, subst(v)]), files: await readFiles() };
    const auth = authKind.value === "bearer" ? { kind: "bearer", token: subst(token.value.trim()) } : authKind.value === "dev-user" ? { kind: "dev-user", user: user.value } : { kind: "none" };
    inflight = uuid();
    sendBtn.setAttribute("disabled", ""); cancelBtn.removeAttribute("disabled");
    resp.replaceChildren(el("p", { class: "muted" }, "Sending…"));
    try {
      const r = await api.client.send({ env, target: target.value, method: method.value, path: p, query: query.read().map(([k, v]) => [k, subst(v)]), headers: headers.read().map(([k, v]) => [k, subst(v)]), body, auth, timeoutMs: Number(timeout.value) * 1000, requestId: inflight });
      resp.replaceChildren(renderResponse(r));
    } catch (e) { resp.replaceChildren(el("p", { class: "callout bad" }, icon("circle-x"), e.message)); }
    finally { inflight = null; sendBtn.removeAttribute("disabled"); cancelBtn.setAttribute("disabled", ""); historyBox.replaceChildren(historyList((await api.client.history()).history)); }
  }

  // ---- endpoints, collections, history
  const filter = el("input", { type: "search", placeholder: "Filter endpoints", "aria-label": "Filter endpoints", oninput: () => drawEndpoints() });
  const epList = el("ul", { class: "plain endpoint-list" });
  const load = (r) => { method.value = r.method; path.value = r.path; drawParams(); if (r.access === "public") authKind.value = "none"; else if (users.length && authKind.value === "none") { authKind.value = "dev-user"; } drawAuth(); if (["POST", "PUT", "PATCH"].includes(r.method) && bodyKind.value === "none") { bodyKind.value = "json"; drawBody(); } const preferred = t.targets.find((x) => (r.source === "orchestrator" ? x.id === "edge:api" : x.id === `service:${r.service}` && !x.refused)) ?? t.targets.find((x) => r.source === "orchestrator" && x.id === "process:" + (t.targets.find((y) => y.id.startsWith("process:"))?.id.slice(8))); if (preferred) target.value = preferred.id; };
  const drawEndpoints = () => { const q = filter.value.toLowerCase(); epList.replaceChildren(...t.endpoints.filter((r) => `${r.method} ${r.path} ${r.module}`.toLowerCase().includes(q)).map((r) => el("li", {}, el("button", { class: "endpoint", type: "button", onclick: () => load(r) }, MethodBadge(r.method), el("span", { class: "mono" }, r.path), el("span", { class: "muted small" }, `${r.source === "orchestrator" ? r.access : r.source}`))))); if (!epList.children.length) epList.append(el("li", { class: "muted" }, "No endpoint matches.")); };
  const collName = el("input", { type: "text", placeholder: "Name of this request", "aria-label": "Request name", spellcheck: "false" });
  const savedBox = el("ul", { class: "plain" });
  // a saved or reference request fills the builder, its authentication included (a development user is a name, never a token)
  const loadSaved = (r) => {
    if (r.target && [...target.options].some((o) => o.value === r.target)) target.value = r.target;
    method.value = r.method; path.value = r.path; query.set(r.query ?? []); headers.set(r.headers ?? []);
    bodyKind.value = r.body?.kind ?? "none"; bodyText.value = r.body?.text ?? ""; drawBody();
    if (r.auth?.kind && [...authKind.options].some((o) => o.value === r.auth.kind)) { authKind.value = r.auth.kind; if (r.auth.user && [...user.options].some((o) => o.value === r.auth.user)) user.value = r.auth.user; drawAuth(); }
    if (r.variables) for (const [k, v] of r.variables) if (!vars.read().some(([n]) => n === k)) vars.set([...vars.read(), [k, v]]);
    drawParams();
  };
  // reference collections are version-controlled files of the workspace (docs/api/*.collection.json): read-only here
  const referenceBox = el("div", { class: "stack" }, ...(coll.reference ?? []).map((c) => el("details", {}, el("summary", {}, `${c.name} `, el("span", { class: "muted small" }, `${c.requests.length} request(s), ${c.file}`)),
    c.description ? el("p", { class: "muted small" }, c.description) : null,
    el("ul", { class: "plain" }, ...c.requests.map((r) => el("li", { class: "row" }, el("button", { class: "link", type: "button", onclick: () => loadSaved({ ...r, variables: c.variables }) }, MethodBadge(r.method), ` ${r.name}`), r.note ? el("span", { class: "muted small" }, ` ${r.note}`) : null))))));
  const drawSaved = () => savedBox.replaceChildren(...(coll.requests ?? []).map((r, i) => el("li", { class: "row" }, el("button", { class: "link", type: "button", onclick: () => loadSaved(r) }, MethodBadge(r.method), ` ${r.name}`), el("button", { class: "icon-btn", type: "button", "aria-label": `Delete ${r.name}`, onclick: async () => { coll.requests.splice(i, 1); await api.client.saveCollections(coll); drawSaved(); } }, icon("trash-2")))));
  const saveReq = Button({ label: "Save request", iconName: "save", variant: "ghost", onclick: async () => { if (!collName.value.trim()) { toast("Give the request a name", "bad"); return; } coll.requests = [...(coll.requests ?? []).filter((r) => r.name !== collName.value.trim()), { name: collName.value.trim(), target: target.value, method: method.value, path: path.value, query: query.read(), headers: headers.read(), body: bodyKind.value === "json" || bodyKind.value === "raw" ? { kind: bodyKind.value, text: bodyText.value } : { kind: "none" }, auth: authKind.value === "dev-user" ? { kind: "dev-user", user: user.value } : { kind: authKind.value } }]; coll.variables = vars.read(); const r = await api.client.saveCollections(coll); toast(`saved${r.droppedSensitiveVariables ? ` (${r.droppedSensitiveVariables} sensitive variable(s) kept in memory only)` : ""}`); drawSaved(); } });
  const historyBox = el("div", {}, historyList(hist.history));
  drawParams(); drawAuth(); drawBody(); drawEndpoints(); drawSaved();

  return Page({ title: "API Client", question: "Send real requests to this workspace's endpoints, through the orchestrator or directly to a service, with real credentials.", docs: { path: "infrastructure/studio-api-client.html", text: "API Client" } },
    el("p", { class: "callout info" }, icon("shield-check"), "Requests go only to the targets this workspace declares (the API and each shell through the edge, the services as local processes or, when published, directly). TLS is verified against the environment's authority, redirects are not followed, credentials are masked in the history, and the history keeps no bodies."),
    el("div", { class: "client-grid" },
      Panel({ title: "Endpoints", iconName: "route", help: "Discovered from ROUTES.pso.ts and the services' contracts." }, filter, epList),
      el("div", { class: "stack" },
        Panel({ title: "Request", iconName: "send" },
          el("div", { class: "row wrap" }, el("label", { class: "field" }, el("span", { class: "muted small" }, "Target"), target)),
          el("div", { class: "row" }, method, path), paramsBox,
          el("details", { open: true }, el("summary", {}, "Query parameters"), query.node),
          el("details", {}, el("summary", {}, "Headers"), headers.node),
          el("details", { open: true }, el("summary", {}, "Authentication"), el("div", { class: "row wrap" }, authKind, authExtra)),
          el("details", {}, el("summary", {}, "Body"), bodyKind, bodyBox),
          el("details", {}, el("summary", {}, "Variables ({{name}} in path, headers, body)"), vars.node, el("p", { class: "muted small" }, "Variables whose name looks sensitive (token, secret, password) are kept in memory only, never saved.")),
          el("div", { class: "row wrap" }, el("label", { class: "field" }, el("span", { class: "muted small" }, "Timeout (s)"), timeout), sendBtn, cancelBtn),
          el("div", { class: "row wrap" }, collName, saveReq)),
        Panel({ title: "Response", iconName: "inbox" }, resp))),
    ...((coll.reference ?? []).length ? [Panel({ title: "Reference requests", iconName: "book-open" }, el("p", { class: "muted small" }, "Generated with the reference CRUD: through the orchestrator (the public API) or directly to the microservice (authorized by the service itself). Load one, then send it."), referenceBox)] : []),
    Panel({ title: "Saved requests", iconName: "save" }, savedBox),
    Panel({ title: "History (last 100, credentials masked, no bodies)", iconName: "history", actions: [Button({ label: "Clear", iconName: "trash-2", variant: "ghost", onclick: async () => { await api.client.clearHistory(); historyBox.replaceChildren(historyList([])); } })] }, historyBox));
}

function renderResponse(r) {
  if (r.error) return el("div", { class: "stack" }, el("p", { class: "callout bad" }, icon("circle-x"), `${r.code ?? "error"}: ${r.error}`), r.timeMs !== null && r.timeMs !== undefined ? el("p", { class: "muted small" }, `after ${r.timeMs} ms — ${r.url ?? ""}`) : null);
  const tone = r.status < 300 ? "ok" : r.status < 400 ? "neutral" : r.status < 500 ? "warn" : "bad";
  let body = r.text ?? "";
  if (/json/i.test(r.contentType) && body) { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* not JSON after all */ } }
  return el("div", { class: "stack" },
    el("div", { class: "row wrap" }, Badge(`${r.status} ${r.statusText}`, tone), el("span", { class: "muted" }, `${r.timeMs} ms`), el("span", { class: "muted" }, `${r.size} bytes${r.truncated ? " (truncated)" : ""}`), r.tls ? Badge(`TLS ${r.tls.protocol ?? ""} verified`, r.tls.authorized ? "ok" : "bad") : Badge("plain HTTP (loopback)", "neutral")),
    el("p", { class: "mono small muted" }, r.url),
    el("details", {}, el("summary", {}, `Response headers (${r.headers.length})`), el("table", { class: "kv-table" }, el("tbody", {}, r.headers.map(([k, v]) => el("tr", {}, el("th", { class: "mono" }, k), el("td", { class: "mono" }, v)))))),
    r.base64 !== undefined ? el("p", { class: "muted" }, `binary response (${r.contentType || "unknown type"}): ${r.size} bytes`) : el("pre", { class: "response-body", tabindex: "0" }, body || "(empty body)"));
}

function historyList(h) {
  if (!h.length) return el("p", { class: "muted" }, "No requests yet.");
  return el("table", { class: "kv-table" }, el("thead", {}, el("tr", {}, ["When", "Request", "Target", "Auth", "Status", "ms"].map((x) => el("th", {}, x)))), el("tbody", {}, h.slice(0, 50).map((x) => el("tr", {}, el("td", { class: "small" }, new Date(x.at).toLocaleTimeString()), el("td", {}, MethodBadge(x.method), " ", code(x.path)), el("td", { class: "small mono" }, x.target), el("td", { class: "small" }, x.auth), el("td", {}, x.status !== null ? Badge(String(x.status), x.status < 400 ? "ok" : "warn") : Badge(x.error ? "error" : "-", "bad")), el("td", { class: "small" }, x.timeMs ?? "-")))));
}
