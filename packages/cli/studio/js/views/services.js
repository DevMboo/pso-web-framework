import { api } from "../api.js";
import { el, icon, Badge, DataTable, EmptyState, KeyValues, MethodBadge, Panel, StatusIndicator, openDrawer, Button, CopyButton, SearchField, SelectFilter, plural } from "../ui.js";
import { Page, DOCS, CommandHint, code } from "./common.js";

const sevTone = (v) => (v === "critical" || v === "high" ? "bad" : v === "medium" ? "warn" : "neutral");

/** The effective PSO configuration of a Spring service, read from application*.yml. Secret values are never part of it. */
function SpringConfig(c) {
  const chips = (list) => (list.length ? list.map((x) => el("span", { class: "chip mono" }, x)) : "none");
  return el("div", { class: "stack" },
    el("h3", {}, "Spring Boot configuration"),
    KeyValues([
      ["Endpoint prefix", c.service.prefix === null ? Badge("invalid", "bad") : el("span", {}, code(c.service.prefix || "(none)"), c.service.prefix !== c.service.workspacePrefix ? Badge("differs from workspace", "bad") : null)],
      ["PSO starters", chips(c.starters)], ["Lombok", c.lombok ? "yes" : Badge("no", "warn")], ["Profiles", chips(c.profiles)],
      ["Security", c.security.enabled ? Badge("starter enabled", "ok") : Badge("pso.security.enabled=false", "bad")],
      ["JWT", `issuer ${c.security.jwt.issuer}; audience ${c.security.jwt.audience}; keys ${c.security.jwt.jwksUri}; algorithms ${c.security.jwt.algorithms.join(", ") || "-"}`],
      ["CORS", c.security.cors.enabled ? `${c.security.cors.origins} origin(s), ${c.security.cors.patterns} pattern(s)${c.security.cors.credentials ? ", credentials" : ""}` : "disabled"],
      ["Rules", `${c.security.rules} (${c.security.publicRules} public)`],
      ["HTTP client", c.httpClient.services.length ? c.httpClient.services.map((x) => `${x.name} -> ${x.host}${x.forwardBearer ? " (forwards bearer)" : ""}${x.mtls ? " (mTLS)" : ""}`).join("; ") : "no services declared"],
      ["Limits", `${c.limits.requestsEnabled ? `${c.limits.perMinute}/min` : "no rate limit"}; body ${c.limits.bodyMax}; multipart ${c.limits.multipart ? "on" : "off"}`],
      ["Database", c.database.provider + (c.database.localProvider ? ` (local profile: ${c.database.localProvider})` : "")],
      ["Dispatch", c.dispatch.enabled ? `enabled, provider ${c.dispatch.provider}` : "disabled"],
    ]),
    c.findings.length ? el("ul", { class: "plain" }, c.findings.map((f) => el("li", { class: "diag" }, Badge(f.id, sevTone(f.severity)), el("span", {}, f.message), el("span", { class: "muted small" }, `Fix: ${f.remediation}`)))) : el("p", { class: "muted" }, "The configuration validates (pso security:validate)."),
    el("a", { class: "doc-link", href: "/docs/spring/configuration.html", target: "_blank", rel: "noopener" }, icon("book-open"), "Spring configuration reference"));
}

/** Full detail of one service, used both by the drawer (topology) and by the dedicated page. */
export function ServiceDetail(d, go) {
  return el("div", { class: "stack" },
    el("div", { class: "row wrap" }, StatusIndicator(d.health.state), el("span", { class: "muted" }, d.health.reason)),
    KeyValues([
      ["Role", d.role], ["Runtime", d.runtime], ["Host / port", el("span", { class: "mono" }, `${d.host}:${d.port}`)],
      ["Health endpoint", d.healthPath ? code(d.healthPath) : "-"], ["Probe", d.probe.httpStatus !== null ? `HTTP ${d.probe.httpStatus}${d.probe.ms !== null ? ` in ${d.probe.ms} ms` : ""}` : "no response"],
      ["Lifecycle (pso dev)", d.registry ? `${d.registry.state}${d.registry.pid ? `, pid ${d.registry.pid}` : ""}` : "not started by pso dev"],
      ["Database", d.database ?? "none declared"], ["Source path", code(d.path)],
    ]),
    d.registry?.error ? el("p", { class: "callout bad" }, icon("circle-x"), d.registry.error) : null,
    el("h3", {}, "Dependencies"),
    el("p", {}, "Depends on: ", d.dependsOn.length ? d.dependsOn.map((n) => el("a", { href: `#/services/${n}`, class: "chip" }, n)) : "nothing declared"),
    el("p", {}, "Used by: ", d.dependents.length ? d.dependents.map((n) => el("a", { href: `#/services/${n}`, class: "chip" }, n)) : "nothing declared"),
    el("h3", {}, `Routes targeting this service (${d.routes.length})`),
    d.routes.length ? el("ul", { class: "plain" }, d.routes.map((r) => el("li", {}, MethodBadge(r.method), " ", el("span", { class: "mono" }, r.path), " ", Badge(r.access, r.public ? "warn" : r.access === "denied" ? "bad" : "ok")))) : el("p", { class: "muted" }, "No orchestrator route is declared for this service."),
    el("h3", {}, `Discovered resources (${d.resources.length})`),
    d.resources.length ? el("ul", { class: "plain mono small" }, d.resources.slice(0, 40).map((r) => el("li", {}, `${r.kind}: ${r.id}`))) : el("p", { class: "muted" }, "None discovered."),
    d.spring ? SpringConfig(d.spring) : null,
    el("h3", {}, "Diagnostics"),
    d.findings.length ? el("ul", { class: "plain" }, d.findings.map((f) => el("li", {}, Badge(f.severity, f.severity === "critical" || f.severity === "high" ? "bad" : "warn"), " ", el("span", { class: "mono" }, f.id), " ", f.message))) : el("p", { class: "muted" }, "No static security findings for this service's files."),
    el("div", { class: "row wrap" }, CommandHint(`pso services:inspect ${d.name}`)),
    go ? el("p", {}, el("a", { href: `#/services/${d.name}` }, "Open full page")) : null);
}

export async function openServiceDrawer(name) {
  const d = await api.service(name);
  openDrawer({ title: d.name, subtitle: `${d.role} / ${d.runtime}`, body: ServiceDetail(d, true), actions: CopyButton(() => `${d.name}: ${d.health.state} - ${d.health.reason}`, "Copy status") });
}

const state = { q: "", health: "" };
export async function servicesView(ctx) {
  if (ctx.params[0]) {
    let d;
    try { d = await api.service(ctx.params[0]); } catch (e) { if (e.status === 404) return Page({ title: "Service not found", question: `There is no service named "${ctx.params[0]}" in this workspace.` }, EmptyState({ title: "Unknown service", text: "Pick one from the services list.", action: el("a", { class: "btn", href: "#/services" }, "Back to services") })); throw e; }
    return Page({ title: d.name, question: "What is this service doing right now, and what depends on it?", docs: { path: DOCS.services, text: "Service communication" }, actions: el("a", { class: "btn ghost", href: "#/services" }, icon("arrow-left"), "All services") }, Panel({ className: "narrow" }, ServiceDetail(d, false)));
  }
  const o = await api.overview();
  const rows = o.services.filter((s) => (!state.q || s.name.includes(state.q.toLowerCase())) && (!state.health || s.health.state === state.health));
  return Page({ title: "Services", question: "Which services exist, are they healthy, and how are they connected?", docs: { path: DOCS.services } },
    el("div", { class: "toolbar" },
      SearchField({ label: "Search services", value: state.q, placeholder: "Search by name", onchange: (v) => { state.q = v; ctx.rerender(); } }),
      SelectFilter({ label: "Health", value: state.health, options: [["", "All states"], ["healthy", "Healthy"], ["degraded", "Degraded"], ["unhealthy", "Unhealthy"], ["stopped", "Stopped"], ["unknown", "Unknown"]], onchange: (v) => { state.health = v; ctx.rerender(); } })),
    o.services.length === 0
      ? EmptyState({ title: "No services declared", text: "Declare services in pso.workspace.json.", action: CommandHint("pso create service <name>") })
      : DataTable({
        caption: "Services", rows, pageSize: 25, rowLabel: (r) => `Open ${r.name}`, onRowClick: (r) => { location.hash = `#/services/${r.name}`; },
        columns: [
          { key: "name", label: "Service", render: (r) => el("strong", {}, r.name) },
          { key: "health", label: "Health", sort: (a, b) => a.health.state.localeCompare(b.health.state), render: (r) => StatusIndicator(r.health.state, { reason: r.health.reason }) },
          { key: "runtime", label: "Runtime" }, { key: "role", label: "Role" },
          { key: "port", label: "Port", mono: true },
          { key: "prefix", label: "Prefix", mono: true, render: (r) => (r.prefix === null ? "-" : r.prefix || "(none)") },
          { key: "dependsOn", label: "Depends on", sortable: false, render: (r) => r.dependsOn.join(", ") || "-" },
          { key: "probe", label: "Probe", sortable: false, render: (r) => (r.live?.httpStatus != null ? `HTTP ${r.live.httpStatus}, ${r.live.ms} ms` : "no response") },
        ],
        empty: EmptyState({ title: "No service matches", text: `${plural(o.services.length, "service")} exist; adjust the filters.` }),
      }));
}
