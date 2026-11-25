import { api } from "../api.js";
import { ModuleGraph } from "../graph.js";
import { el, icon, Badge, CopyButton, EmptyState, KeyValues, openDrawer, Panel, DataTable } from "../ui.js";
import { Page, DOCS, CommandHint, code } from "./common.js";

let selected = null;

function ModuleDetail(m) {
  const list = (a) => (a.length ? el("ul", { class: "plain mono small" }, a.map((x) => el("li", {}, x))) : el("p", { class: "muted" }, "none"));
  return el("div", { class: "stack" },
    KeyValues([
      ["Declaration", m.hasModule ? code(m.moduleFile) : Badge("MODULE.pso.ts missing", "bad")], ["Route registry", m.hasRoutes ? code(m.routesFile) : Badge("ROUTES.pso.ts missing", "bad")],
      ["Registry linked", m.routesFromOwnRegistry ? Badge("MODULE.routes -> ROUTES.pso", "ok") : Badge("not linked", "warn", "MODULE.pso.ts must reference this directory's ROUTES.pso.ts")],
      ["Routes", String(m.routeCount)], ["Module policy", m.security ? JSON.stringify(m.security) : "none (inherits the framework default)"],
    ]),
    el("h3", {}, "Controllers"), list(m.controllers),
    m.undeclaredControllers.length ? el("p", { class: "callout warn" }, icon("triangle-alert"), `Not declared (never exposed): ${m.undeclaredControllers.join(", ")}`) : null,
    el("h3", {}, "Providers and their dependencies"), m.providerDeps.length ? el("ul", { class: "plain mono small" }, m.providerDeps.map((p) => el("li", {}, `${p.name}${p.deps.length ? ` <- ${p.deps.join(", ")}` : ""}`))) : el("p", { class: "muted" }, "none"),
    el("h3", {}, "Imports"), list(m.imports), el("h3", {}, "Exports"), list(m.exports),
    m.shapeErrors.length ? el("div", {}, el("h3", {}, "Declaration errors"), list(m.shapeErrors)) : null,
    el("h3", {}, `Validation (${m.diagnostics.length})`),
    m.diagnostics.length ? el("ul", { class: "plain" }, m.diagnostics.map((d) => el("li", { class: "diag" }, Badge(d.code, d.severity === "error" ? "bad" : "warn"), el("pre", { class: "diag-text" }, d.message)))) : el("p", { class: "muted" }, "No validation diagnostics for this module."),
    el("div", { class: "row wrap" }, CommandHint("pso validate"), el("a", { class: "doc-link", href: `/docs/${DOCS.modules}`, target: "_blank", rel: "noopener" }, icon("book-open"), "Module docs")));
}

export async function modulesView(ctx) {
  const d = await api.modules();
  if (!d.orchestrator) return Page({ title: "Modules", question: "How are the orchestrator's modules composed?" }, EmptyState({ title: "No orchestrator in this workspace", text: "Modules belong to an orchestrator.", iconName: "boxes", action: CommandHint("pso create orchestrator <name>") }));
  const open = (key) => { const m = d.modules.find((x) => (x.name ?? x.dir) === key || x.dir === key); selected = key; if (m) openDrawer({ title: m.name ?? m.dir, subtitle: `routes/${m.dir}`, body: ModuleDetail(m), actions: CopyButton(() => `${m.name ?? m.dir}: ${m.controllers.length} controllers, ${m.routeCount} routes, ${m.diagnostics.length} diagnostics`, "Copy") }); };
  return Page({ title: "Modules", question: "How are modules composed, and is any declaration broken?", docs: { path: DOCS.modules } },
    d.diagnostics.length ? el("p", { class: "callout bad" }, icon("circle-x"), `${d.diagnostics.length} workspace-level diagnostic(s): ${d.diagnostics.map((x) => x.code).join(", ")}. See Diagnostics.`) : null,
    d.modules.length === 0 ? EmptyState({ title: "No modules yet", text: "Generate a module and its routes registry.", iconName: "boxes", action: CommandHint("pso make:module <name> --service <orchestrator>") }) : el("div", { class: "stack" },
      Panel({ title: "Module imports", iconName: "network", help: "Only MODULE.pso.ts imports are drawn here. Runtime calls between services are shown in the service topology, not in this graph." },
        d.modules.length > 1 || d.imports.length ? ModuleGraph({ modules: d.modules, imports: d.imports, selected, onSelect: open }) : el("p", { class: "muted" }, "Only one module and no imports: there is nothing to connect."),
        d.imports.length === 0 && d.modules.length > 1 ? el("p", { class: "muted" }, "No module imports another module.") : null),
      Panel({ title: "Declared modules", iconName: "boxes" }, DataTable({
        caption: "Modules", rows: d.modules, pageSize: 25, onRowClick: (m) => open(m.name ?? m.dir), rowLabel: (m) => `Inspect module ${m.name ?? m.dir}`,
        columns: [
          { key: "dir", label: "Module", render: (m) => el("strong", {}, m.name ?? m.dir) },
          { key: "controllers", label: "Controllers", render: (m) => String(m.controllers.length), sort: (a, b) => a.controllers.length - b.controllers.length },
          { key: "providers", label: "Providers", render: (m) => String(m.providers.length), sort: (a, b) => a.providers.length - b.providers.length },
          { key: "imports", label: "Imports", render: (m) => m.imports.join(", ") || "-", sortable: false },
          { key: "exports", label: "Exports", render: (m) => m.exports.join(", ") || "-", sortable: false },
          { key: "routeCount", label: "Routes", sort: (a, b) => a.routeCount - b.routeCount },
          { key: "diagnostics", label: "Validation", sort: (a, b) => a.diagnostics.length - b.diagnostics.length, render: (m) => (m.diagnostics.length || !m.hasModule ? Badge(!m.hasModule ? "no MODULE.pso.ts" : `${m.diagnostics.length} issue(s)`, "bad") : Badge("valid", "ok")) },
        ],
      }))));
}
