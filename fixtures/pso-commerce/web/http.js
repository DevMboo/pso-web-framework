// The only way this page talks HTTP. Guardrails, in order:
//  1. the target is ALWAYS this page's own origin (the PSO gateway); there is no URL field and no proxy;
//  2. method + path must match a route the deployed release publishes (routes.json); nothing else can be sent;
//  3. the bearer token is attached from memory and never written into the exchange record, the history or the DOM;
//  4. TLS is never bypassed: a certificate problem surfaces as a failed request, which the page reports as such.

export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FORBIDDEN_HEADERS = new Set(["authorization", "host", "cookie", "set-cookie", "origin", "referer", "content-length", "connection", "transfer-encoding", "upgrade", "proxy-authorization"]);
export const TIMEOUT_MS = 30_000;

let published = [];
export const setPublished = (routes) => { published = routes.map((r) => ({ ...r, regex: toRegex(r.path) })); };
export const publishedRoutes = () => published;
const toRegex = (p) => new RegExp("^" + p.split("/").map((s) => (s.startsWith(":") ? "[^/?#]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$");

/** Replaces `:name` segments with encoded values. Returns { path, missing }. */
export function fill(template, params) {
  const missing = [];
  const path = template.split("/").map((s) => { if (!s.startsWith(":")) return s; const v = (params[s.slice(1)] ?? "").trim(); if (!v) missing.push(s.slice(1)); return encodeURIComponent(v); }).join("/");
  return { path, missing };
}
export const paramsOf = (template) => template.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1));

export function findRoute(method, path) { return published.find((r) => r.method === method && r.regex.test(path)); }

export class Refusal extends Error {}

/**
 * @param {{method:string, path:string, query?:Record<string,string>, headers?:Record<string,string>, body?:string, token?:string, signal?:AbortSignal, timeoutMs?:number}} r
 * Resolves to an exchange record; never throws for HTTP statuses or network failures (they are part of the record).
 */
export async function send(r) {
  const method = r.method.toUpperCase();
  if (!/^\/[A-Za-z0-9._~\-/%]*$/.test(r.path)) throw new Refusal("the path contains characters this page does not send");
  const route = findRoute(method, r.path);
  if (!route) throw new Refusal(`${method} ${r.path} is not a route published by this release`);
  const url = new URL(r.path, location.origin);
  for (const [k, v] of Object.entries(r.query ?? {})) if (k.trim()) url.searchParams.append(k.trim(), v);
  const headers = { accept: "application/json" };
  for (const [k, v] of Object.entries(r.headers ?? {})) { const name = k.trim().toLowerCase(); if (!name) continue; if (FORBIDDEN_HEADERS.has(name) || !/^[a-z0-9-]+$/.test(name)) throw new Refusal(`the header "${k}" cannot be set from this page`); headers[name] = v; }
  let body;
  if (r.body !== undefined && r.body !== "" && method !== "GET" && method !== "HEAD") { try { JSON.parse(r.body); } catch (e) { throw new Refusal(`the body is not valid JSON: ${e.message}`); } body = r.body; headers["content-type"] = "application/json"; }
  if (r.token) headers.authorization = `Bearer ${r.token}`;

  const ctl = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, r.timeoutMs ?? TIMEOUT_MS);
  r.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  const shown = { ...headers }; if (shown.authorization) shown.authorization = "Bearer [token held in memory, not shown]";
  const rec = { at: new Date(), method, path: url.pathname + url.search, url: url.href, route: route.id, scopes: route.scopes, request: { headers: shown, body: body ?? null } };
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const text = await res.text(); rec.ms = performance.now() - t0;
    const hs = {}; res.headers.forEach((v, k) => { hs[k] = v; });
    rec.response = { status: res.status, statusText: res.statusText, headers: hs, body: text };
    try { rec.response.json = JSON.parse(text); } catch { /* not JSON */ }
  } catch (e) {
    rec.ms = performance.now() - t0;
    if (timedOut) rec.error = { kind: "timeout", message: `no response within ${Math.round((r.timeoutMs ?? TIMEOUT_MS) / 1000)} s` };
    else if (e.name === "AbortError") rec.error = { kind: "cancelled", message: "cancelled by the user" };
    else rec.error = { kind: "network", message: "the browser could not complete the request: the server is unreachable, the connection was reset, or the TLS certificate is not trusted by this browser. Browsers do not reveal which; check that the address bar shows no certificate warning, then see the access instructions." };
  } finally { clearTimeout(timer); }
  return rec;
}
