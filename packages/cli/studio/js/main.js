// Application shell: sidebar, topbar, hash router, theme, global search and controlled refresh.
// Views are plain modules returning DOM; they get a small context and never touch the network directly (see api.js).
import { api, cancelPending, connection, isAbort, onConnection } from "./api.js";
import { el, icon, closeDrawer, ErrorState, Skeleton, toast } from "./ui.js";
import { overviewView } from "./views/overview.js";
import { workspacesView } from "./views/workspaces.js";
import { servicesView } from "./views/services.js";
import { routesView } from "./views/routes.js";
import { modulesView } from "./views/modules.js";
import { dispatchView } from "./views/dispatch.js";
import { securityView } from "./views/security.js";
import { observabilityView } from "./views/observability.js";
import { diagnosticsView } from "./views/diagnostics.js";
import { settingsView } from "./views/settings.js";
import { cloudView } from "./views/cloud.js";
import { frontendView } from "./views/frontend.js";
import { infrastructureView, containersView, hostsView, certificatesView, deploymentView } from "./views/infra-console.js";
import { apiClientView } from "./views/apiclient.js";
import { remoteView } from "./views/remote.js";

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked; the UI still works */ } },
};

const NAV = [
  ["overview", "layout-dashboard", "Overview", overviewView, 5000], ["workspaces", "folder-tree", "Workspaces", workspacesView, 0],
  ["services", "server", "Services", servicesView, 5000], ["routes", "route", "Routes", routesView, 0],
  ["modules", "boxes", "Modules", modulesView, 0], ["frontend", "panels-top-left", "Frontend", frontendView, 0], ["dispatch", "workflow", "Dispatch", dispatchView, 0],
  ["infrastructure", "layers", "Infrastructure", infrastructureView, 0], ["containers", "container", "Containers", containersView, 10000], ["hosts", "globe", "Hosts", hostsView, 0],
  ["security", "shield-check", "Security", securityView, 0], ["certificates", "key-round", "Certificates", certificatesView, 0], ["api-client", "send", "API Client", apiClientView, 0], ["deployment", "rocket", "Deployment", deploymentView, 0], ["remote", "server-cog", "Remote hosts", remoteView, 0], ["cloud", "cloud", "Cloud", cloudView, 0], ["observability", "scroll-text", "Observability", observabilityView, 5000],
  ["diagnostics", "stethoscope", "Diagnostics", diagnosticsView, 0], ["settings", "settings", "Settings", settingsView, 0],
];

let envName = "development";
const ctx = {
  params: [], env: () => envName,
  setEnv(v) { envName = v; try { sessionStorage.setItem("pso-studio-env", v); } catch { /* ignore */ } renderEnv(); render(); },
  rerender: () => render({ keepScroll: true }),
};

// ---------------------------------------------------------------- theme
function applyTheme(t) { document.documentElement.dataset.theme = t; store.set("pso-studio-theme", t); }
function themeToggle() {
  const b = el("button", { class: "icon-btn", type: "button", "aria-label": "Switch theme", onclick: () => { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); sync(); } });
  const sync = () => { const light = document.documentElement.dataset.theme === "light"; b.replaceChildren(icon(light ? "moon" : "sun")); b.title = light ? "Switch to the dark theme" : "Switch to the light theme"; };
  sync();
  return b;
}

// ---------------------------------------------------------------- shell
const sidebar = el("aside", { id: "sidebar", class: "sidebar", "aria-label": "Primary" });
const topbar = el("header", { class: "topbar" });
const main = el("main", { id: "main", tabindex: "-1" });

function buildSidebar() {
  const collapsed = store.get("pso-studio-nav", "open") === "closed";
  document.getElementById("app").classList.toggle("collapsed", collapsed);
  const items = NAV.map(([id, ic, label]) => el("a", { class: "nav-item", href: `#/${id}`, dataset: { id }, title: label }, icon(ic), el("span", { class: "nav-label" }, label)));
  sidebar.replaceChildren(
    el("a", { class: "brand", href: "#/overview", "aria-label": "PSO Studio overview" }, el("img", { src: "/favicon.svg", alt: "", width: 26, height: 26 }), el("span", { class: "brand-name" }, "PSO ", el("b", {}, "Studio"))),
    el("nav", { "aria-label": "Sections" }, el("ul", {}, items.map((a) => el("li", {}, a)), el("li", {}, el("a", { class: "nav-item", href: "/docs/", target: "_blank", rel: "noopener", title: "Documentation (opens in a new tab)" }, icon("book-open"), el("span", { class: "nav-label" }, "Documentation"), icon("external-link", "ext"))))),
    el("button", { class: "nav-collapse", type: "button", "aria-label": "Collapse navigation", "aria-pressed": String(collapsed), onclick: (e) => {
      const app = document.getElementById("app"); const c = !app.classList.contains("collapsed"); app.classList.toggle("collapsed", c); e.currentTarget.setAttribute("aria-pressed", String(c)); store.set("pso-studio-nav", c ? "closed" : "open");
    } }, icon("panel-left-close"), el("span", { class: "nav-label" }, "Collapse")));
}

let envPill, connPill, wsName, searchBox, results;
function renderEnv() { if (envPill) { envPill.textContent = envName; envPill.className = `pill env ${envName === "production" ? "bad" : envName === "staging" ? "warn" : "neutral"}`; envPill.title = `Environment used for configuration and security validation (set in Settings)`; } }

function buildTopbar() {
  wsName = el("span", { class: "ws-name" }, "...");
  envPill = el("span", { class: "pill env" });
  connPill = el("span", { class: "pill conn", role: "status" });
  results = el("ul", { id: "search-results", class: "search-results", role: "listbox", "aria-label": "Search results", hidden: true });
  searchBox = el("input", { type: "search", placeholder: "Search services, routes, modules   (/)", "aria-label": "Global search", role: "combobox", "aria-expanded": "false", "aria-controls": "search-results", autocomplete: "off", spellcheck: "false" });
  searchBox.addEventListener("input", runSearch);
  searchBox.addEventListener("focus", loadIndex);
  searchBox.addEventListener("keydown", searchKeys);
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideResults(); });
  topbar.replaceChildren(
    el("button", { class: "icon-btn menu-btn", type: "button", "aria-label": "Open navigation", onclick: () => document.getElementById("app").classList.toggle("nav-open") }, icon("menu")),
    el("div", { class: "ws-chip", title: "Active workspace" }, icon("folder-tree"), wsName),
    envPill,
    el("div", { class: "search" }, icon("search"), searchBox, results),
    el("div", { class: "top-right" }, connPill,
      el("button", { class: "icon-btn", type: "button", "aria-label": "Refresh data", title: "Refresh now", onclick: () => { cancelPending(); render({ keepScroll: true }); } }, icon("refresh-cw")), themeToggle()));
  renderEnv();
  onConnection((c) => {
    const map = { connecting: ["Connecting", "idle"], connected: [`Connected${c.lastOk ? ` ${c.lastOk.toLocaleTimeString()}` : ""}`, "ok"], disconnected: ["Disconnected", "bad"], unauthorized: ["Access denied", "bad"], error: ["Error", "warn"] };
    const [t, tone] = map[c.state] ?? map.connecting;
    connPill.className = `pill conn ${tone}`; connPill.replaceChildren(icon(c.state === "connected" ? "wifi" : "wifi-off"), t); connPill.title = c.lastError ?? "Last request succeeded";
  });
}

// ---------------------------------------------------------------- global search (client side, over real API data)
let index = null, indexing = false, active = -1;
async function loadIndex() {
  if (index || indexing) return; indexing = true;
  try {
    const [o, r, m] = await Promise.all([api.overview(), api.routes(), api.modules()]);
    index = [
      ...o.services.map((s) => ({ kind: "Service", label: s.name, sub: `${s.role}, ${s.health.state}`, href: `#/services/${s.name}` })),
      ...r.map((x) => ({ kind: "Route", label: `${x.method} ${x.path}`, sub: x.module, href: "#/routes" })),
      ...m.modules.map((x) => ({ kind: "Module", label: x.name ?? x.dir, sub: `${x.controllers.length} controllers`, href: "#/modules" })),
      ...NAV.map(([id, , label]) => ({ kind: "Page", label, sub: "", href: `#/${id}` })),
    ];
  } catch { index = null; } finally { indexing = false; if (index && searchBox.value.trim()) runSearch(); } // typing may have started before the index arrived
}
function hideResults() { results.hidden = true; searchBox.setAttribute("aria-expanded", "false"); active = -1; }
function runSearch() {
  const q = searchBox.value.trim().toLowerCase();
  if (!q || !index) return hideResults();
  const hits = index.filter((i) => `${i.label} ${i.sub} ${i.kind}`.toLowerCase().includes(q)).slice(0, 12);
  results.replaceChildren(...(hits.length ? hits.map((h, i) => el("li", { role: "option", id: `sr-${i}`, "aria-selected": "false" }, el("a", { href: h.href, onclick: () => { hideResults(); searchBox.value = ""; } }, el("span", { class: "badge neutral" }, h.kind), el("span", { class: "sr-label" }, h.label), h.sub ? el("span", { class: "muted small" }, h.sub) : null))) : [el("li", { class: "sr-empty", role: "option", "aria-disabled": "true", "aria-selected": "false" }, "No results")]));
  results.hidden = false; searchBox.setAttribute("aria-expanded", "true"); active = -1;
}
function searchKeys(e) {
  const opts = [...results.querySelectorAll("li:not(.sr-empty)")];
  if (e.key === "Escape") { hideResults(); searchBox.blur(); return; }
  if (!opts.length || results.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === active))); searchBox.setAttribute("aria-activedescendant", opts[active].id); opts[active].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") { e.preventDefault(); (opts[active] ?? opts[0]).querySelector("a").click(); }
}
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); searchBox.focus(); }
});

// ---------------------------------------------------------------- routing and rendering
function parse() {
  const [id, ...params] = (location.hash.replace(/^#\/?/, "") || "overview").split("/").map(decodeURIComponent);
  const entry = NAV.find((n) => n[0] === id) ?? NAV[0];
  return { entry, params };
}
let current = null, token = 0, pollTimer = null;

async function render({ keepScroll = false } = {}) {
  const { entry, params } = parse();
  const [id, , label, view, poll] = entry;
  const my = ++token;
  const sameView = current === id;
  cancelPending();
  if (!sameView) closeDrawer(false);
  ctx.params = params; current = id;
  document.title = `${label} - PSO Studio`;
  for (const a of sidebar.querySelectorAll(".nav-item[data-id]")) { if (a.dataset.id === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  const scroll = main.scrollTop;
  if (!keepScroll || !main.firstChild) main.replaceChildren(Skeleton(4));
  try {
    const node = await view(ctx);
    if (my !== token) return; // a newer navigation superseded this one
    main.replaceChildren(node);
    if (keepScroll) main.scrollTop = scroll; else { main.scrollTop = 0; if (!sameView) main.focus({ preventScroll: true }); }
  } catch (e) {
    if (isAbort(e) || my !== token) return;
    main.replaceChildren(ErrorState({ text: e.message, onRetry: () => render() }));
  }
  clearTimeout(pollTimer);
  if (poll) pollTimer = setTimeout(tick, poll);
}
function tick() {
  const busy = document.hidden || document.querySelector(".drawer") || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "") || connection.state === "unauthorized";
  if (busy) { pollTimer = setTimeout(tick, 5000); return; }
  render({ keepScroll: true });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && parse().entry[4]) { clearTimeout(pollTimer); tick(); } });
window.addEventListener("hashchange", () => { document.getElementById("app").classList.remove("nav-open"); render(); });

async function start() {
  try { envName = sessionStorage.getItem("pso-studio-env") ?? ""; } catch { envName = ""; }
  buildSidebar(); buildTopbar();
  document.getElementById("app").append(sidebar, el("div", { class: "content" }, topbar, main));
  try { const w = await api.workspace(); wsName.textContent = w.name; if (!envName) envName = w.environment; } catch (e) { wsName.textContent = "unavailable"; }
  if (!envName) envName = "development";
  renderEnv();
  render();
}
start().catch((e) => toast(String(e.message ?? e), "bad"));
