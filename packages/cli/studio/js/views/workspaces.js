import { api } from "../api.js";
import { el, icon, Badge, DataTable, KeyValues, Panel, StatusIndicator } from "../ui.js";
import { Page, DOCS, CommandHint } from "./common.js";

export async function workspacesView() {
  const [w, sum, ov] = await Promise.all([api.workspace(), api.summary(), api.overview()]);
  return Page({ title: "Workspaces", question: "Which workspace am I inspecting and what does it contain?", docs: { path: "concepts/path-structure-working.html", text: "Workspace layout" } },
    el("p", { class: "callout info" }, icon("info"), "Studio inspects the single workspace it was started from. To inspect another one, run pso studio inside it."),
    Panel({ title: w.name, iconName: "folder-tree" },
      KeyValues([["Environment", Badge(w.environment, w.environment === "production" ? "bad" : "neutral")], ["Services", String(w.services)], ["Orchestrator", ov.services.find((s) => s.role === "orchestrator")?.name ?? "none"],
        ["Dev session", sum.devSession ? `pso dev, pid ${sum.devSession.pid}` : "none"], ["Access", "read-only, loopback only"]])),
    Panel({ title: "Declared projects", iconName: "server" }, DataTable({
      caption: "Workspace projects", rows: ov.services, pageSize: 25, onRowClick: (s) => { location.hash = `#/services/${s.name}`; }, rowLabel: (s) => `Open ${s.name}`,
      columns: [{ key: "name", label: "Project", render: (s) => el("strong", {}, s.name) }, { key: "role", label: "Role" }, { key: "runtime", label: "Runtime" }, { key: "port", label: "Port", mono: true },
        { key: "health", label: "Health", render: (s) => StatusIndicator(s.health.state, { reason: s.health.reason }), sort: (a, b) => a.health.state.localeCompare(b.health.state) }],
    })),
    el("div", { class: "row wrap" }, CommandHint("pso validate"), CommandHint("pso graph")));
}
