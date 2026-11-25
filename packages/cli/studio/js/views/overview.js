import { api } from "../api.js";
import { ServiceTopology } from "../graph.js";
import { el, icon, Badge, Button, EmptyState, MetricCard, Panel, StatusIndicator, fmtTime, toast, setVar } from "../ui.js";
import { Page, DOCS, StackedBar, CommandHint } from "./common.js";
import { openServiceDrawer } from "./services.js";

let selected = null;

function LatencyBars(services) {
  const probed = services.filter((s) => s.live?.ms != null);
  if (!probed.length) return EmptyState({ title: "No probe answered", text: "Latency is measured from live health probes. Start services with pso dev to see it.", iconName: "timer" });
  const max = Math.max(...probed.map((s) => s.live.ms), 1);
  return el("ul", { class: "bars", "aria-label": "Health probe latency per service" }, probed.map((s) => {
    const bar = el("span", { class: "bar-fill" }); setVar(bar, "--w", `${Math.max(2, Math.round((s.live.ms / max) * 100))}%`);
    return el("li", {}, el("span", { class: "bar-label" }, s.name), el("span", { class: "bar-track" }, bar), el("span", { class: "bar-value mono" }, `${s.live.ms} ms`));
  }));
}

function Activity(entries, diagnostics) {
  const rows = [
    ...diagnostics.slice(0, 4).map((d) => ({ at: "", tone: d.severity === "error" || d.severity === "critical" || d.severity === "high" ? "bad" : "warn", who: d.source, text: `${d.code}: ${d.message.split("\n")[0]}`, href: "#/diagnostics" })),
    ...entries.slice(-8).reverse().map((e) => ({ at: fmtTime(e.ts), tone: e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "neutral", who: e.service, text: e.msg, href: "#/observability" })),
  ];
  if (!rows.length) return EmptyState({ title: "No recent activity", text: "Logs appear here when services run under pso dev. Diagnostics appear when validation finds problems.", iconName: "activity", action: CommandHint("pso dev") });
  return el("ul", { class: "activity" }, rows.map((r) => el("li", {}, Badge(r.who, r.tone), el("a", { href: r.href, class: "activity-text" }, r.text), r.at ? el("time", { class: "muted" }, r.at) : null)));
}

export async function overviewView(ctx) {
  const [sum, ov, graph, diag, logs] = await Promise.all([api.summary(), api.overview(), api.graph(), api.diagnostics(), api.logs({ limit: 40 })]);
  const s = sum.services;
  const problems = sum.validationErrors + sum.failedServices.length;
  const quick = el("div", { class: "actions" },
    Button({ label: "Inspect workspace", iconName: "folder-tree", onclick: () => { location.hash = "#/workspaces"; } }),
    Button({ label: "Validate configuration", iconName: "shield-check", onclick: async () => { const r = await api.diagnostics({ fresh: 1 }); toast(r.total ? `Validation found ${r.total} diagnostic(s)` : "Validation found no diagnostics", r.total ? "warn" : "ok"); ctx.rerender(); } }),
    Button({ label: "Inspect routes", iconName: "route", onclick: () => { location.hash = "#/routes"; } }),
    Button({ label: "View diagnostics", iconName: "stethoscope", onclick: () => { location.hash = "#/diagnostics"; } }),
    ov.services.length ? Button({ label: "Open service details", iconName: "server", onclick: () => openServiceDrawer(selected && ov.services.some((x) => x.name === selected) ? selected : ov.services[0].name) }) : null,
    el("a", { class: "btn", href: "/docs/", target: "_blank", rel: "noopener" }, icon("book-open"), "Open documentation"));

  return Page({ title: "Overview", question: "Is my distributed application running, and what needs my attention?", docs: { path: DOCS.observability, text: "Runtime docs" } },
    el("div", { class: "metrics seven" },
      MetricCard({ label: "Services", iconName: "server", value: `${s.healthy}/${s.total}`, hint: "healthy of declared", tone: s.total === 0 ? "neutral" : s.healthy === s.total ? "ok" : "warn", href: "#/services" }),
      MetricCard({ label: "Routes", iconName: "route", value: `${sum.routes.active}`, hint: `active of ${sum.routes.declared} declared in ROUTES.pso.ts`, tone: sum.routes.declared && sum.routes.active < sum.routes.declared ? "bad" : "neutral", href: "#/routes" }),
      MetricCard({ label: "Modules", iconName: "boxes", value: String(sum.modules.total), hint: sum.modules.orchestrator ? "loaded from the orchestrator" : "no orchestrator in this workspace", href: "#/modules" }),
      MetricCard({ label: "Runtime", iconName: "activity", value: sum.devSession ? "Dev session" : "No session", hint: sum.devSession ? `pso dev, pid ${sum.devSession.pid}` : "services may run elsewhere", tone: sum.devSession ? "ok" : "neutral" }),
      MetricCard({ label: "Failed services", iconName: "circle-x", value: String(sum.failedServices.length), hint: sum.failedServices.join(", ") || "none", tone: sum.failedServices.length ? "bad" : "ok", href: "#/services" }),
      MetricCard({ label: "Validation errors", iconName: "triangle-alert", value: String(sum.validationErrors), hint: problems ? "see Diagnostics" : "none reported", tone: sum.validationErrors ? "bad" : "ok", href: "#/diagnostics" }),
      MetricCard({ label: "Dispatch", iconName: "workflow", value: sum.dispatch.installed ? "Configured" : "Not installed", hint: "runtime telemetry unavailable", href: "#/dispatch" })),
    el("div", { class: "quick-row", role: "group", "aria-label": "Quick actions" }, quick),
    el("div", { class: "stack" },
      Panel({ title: "Service topology", iconName: "network", help: "Solid lines: dependsOn. Dashed lines: orchestrator routes. Node color is the verified health state. Select a node for details." },
        ov.services.length ? ServiceTopology({ services: ov.services, graph, selected, onSelect: (n) => { selected = n; openServiceDrawer(n).catch((e) => toast(e.message, "bad")); } }) : EmptyState({ title: "No services declared", text: "Create a service to see the topology.", action: CommandHint("pso create service <name>") }),
        graph.cycle ? el("p", { class: "callout bad" }, icon("circle-x"), graph.cycle) : null)),
    el("div", { class: "cols" },
      Panel({ title: "Runtime health", iconName: "heart-pulse", help: "Derived from a live probe and the pso dev lifecycle, never from registration alone." },
        StackedBar([{ label: "healthy", value: s.healthy, tone: "ok" }, { label: "degraded", value: s.degraded, tone: "warn" }, { label: "unhealthy", value: s.unhealthy, tone: "bad" }, { label: "stopped", value: s.stopped, tone: "idle" }, { label: "unknown", value: s.unknown, tone: "unknown" }], "Service health"),
        el("ul", { class: "health-list" }, ov.services.map((x) => el("li", {}, el("a", { href: `#/services/${x.name}` }, x.name), StatusIndicator(x.health.state, { reason: x.health.reason }), el("span", { class: "muted small" }, x.health.reason))))),
      Panel({ title: "Health probe latency", iconName: "timer", help: "The latest measured probe per service. Not a time series." }, LatencyBars(ov.services))),
    Panel({ title: "Recent activity", iconName: "history", help: "Real diagnostics and log lines from this workspace, newest first." }, Activity(logs.entries, diag.items)));
}
