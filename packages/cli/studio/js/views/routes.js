import { api } from "../api.js";
import { el, icon, Badge, CopyButton, DataTable, EmptyState, KeyValues, MethodBadge, openDrawer, SearchField, SelectFilter, plural } from "../ui.js";
import { Page, DOCS, CommandHint, code } from "./common.js";

const state = { q: "", method: "", module: "", service: "", security: "" };

const accessBadge = (r) => (r.public ? Badge("public", "warn", "No authentication required") : r.access === "denied" ? Badge("denied", "bad", "No policy: the route is rejected") : Badge(r.access.replace("guard:", ""), "ok", "Authentication guard"));
const validation = (r) => (!r.active ? Badge("inactive", "bad", "The route registry did not validate: nothing is exposed (fail closed)") : !r.serviceDeclared ? Badge("unknown service", "bad", "The target service is not declared in the workspace") : Badge("active", "ok", "Declared in ROUTES.pso.ts and validated"));

function openRoute(r) {
  openDrawer({
    title: `${r.method} ${r.path}`, subtitle: `${r.module} / ${r.controller}`,
    actions: CopyButton(() => `${r.method} ${r.path} -> ${r.service || "(orchestrator)"} [${r.access}${r.scopes.length ? `; scopes ${r.scopes.join(",")}` : ""}]`, "Copy"),
    body: el("div", { class: "stack" },
      KeyValues([
        ["Validation", validation(r)], ["Module", r.module], ["Controller", code(r.controller)], ["Registry", code(r.file)],
        ["Authentication", accessBadge(r)], ["Guards", r.guards.length ? r.guards.join(", ") : "none"],
        ["Authorization", r.scopes.length ? r.scopes.map((s) => el("span", { class: "chip mono" }, s)) : "no scopes required"],
        ["Target service", r.service ? el("a", { href: `#/services/${r.service}` }, r.service) : "handled by the orchestrator"],
      ]),
      el("p", { class: "muted" }, "A route is active only when it is declared in a valid ROUTES.pso.ts and its module validates. A controller decorator alone never exposes an endpoint."),
      el("div", { class: "row wrap" }, CommandHint(`pso routes:inspect ${r.id}`), el("a", { class: "doc-link", href: `/docs/${DOCS.routes}`, target: "_blank", rel: "noopener" }, icon("book-open"), "Routing docs"), el("a", { class: "doc-link", href: `/docs/${DOCS.authorization}`, target: "_blank", rel: "noopener" }, icon("book-open"), "Authorization docs"))),
  });
}

export async function routesView(ctx) {
  const all = await api.routes();
  const uniq = (k) => [...new Set(all.map((r) => r[k]).filter(Boolean))].sort();
  const rows = all.filter((r) =>
    (!state.method || r.method === state.method) && (!state.module || r.module === state.module) && (!state.service || r.service === state.service) &&
    (!state.security || (state.security === "public" ? r.public : state.security === "protected" ? !r.public && r.guards.length > 0 : r.access === "denied")) &&
    (!state.q || `${r.method} ${r.path} ${r.controller} ${r.module}`.toLowerCase().includes(state.q.toLowerCase())));
  const opts = (label, vals) => [["", label], ...vals.map((v) => [v, v])];
  return Page({ title: "Routes", question: "Which endpoints are really exposed, who may call them, and where do they go?", docs: { path: DOCS.routes },
    actions: CopyButton(() => rows.map((r) => `${r.method} ${r.path} -> ${r.service || "(orchestrator)"} [${r.access}]`).join("\n"), "Copy list") },
    el("p", { class: "callout info" }, icon("info"), "Only routes declared in a valid ROUTES.pso.ts registry are active. The list below is read from those registries."),
    el("div", { class: "toolbar" },
      SearchField({ label: "Search routes", value: state.q, placeholder: "Search method, path, controller", onchange: (v) => { state.q = v; ctx.rerender(); } }),
      SelectFilter({ label: "Method", value: state.method, options: opts("All methods", uniq("method")), onchange: (v) => { state.method = v; ctx.rerender(); } }),
      SelectFilter({ label: "Module", value: state.module, options: opts("All modules", uniq("module")), onchange: (v) => { state.module = v; ctx.rerender(); } }),
      SelectFilter({ label: "Service", value: state.service, options: opts("All services", uniq("service")), onchange: (v) => { state.service = v; ctx.rerender(); } }),
      SelectFilter({ label: "Security", value: state.security, options: [["", "All"], ["public", "Public"], ["protected", "Protected"], ["denied", "Denied (no policy)"]], onchange: (v) => { state.security = v; ctx.rerender(); } })),
    all.length === 0
      ? EmptyState({ title: "No routes declared", text: "Add routes to a module's ROUTES.pso.ts, or generate a resource.", iconName: "route", action: CommandHint("pso make:resource <name> --service <svc> --route /path") })
      : DataTable({
        caption: `Routes (${plural(rows.length, "match", "matches")})`, rows, pageSize: 30, onRowClick: openRoute, rowLabel: (r) => `Inspect ${r.method} ${r.path}`,
        columns: [
          { key: "method", label: "Method", render: (r) => MethodBadge(r.method) },
          { key: "path", label: "Endpoint", mono: true },
          { key: "module", label: "Module" },
          { key: "controller", label: "Controller", mono: true },
          { key: "access", label: "Authentication", render: accessBadge },
          { key: "scopes", label: "Authorization", sortable: false, render: (r) => (r.scopes.length ? r.scopes.join(", ") : "-") },
          { key: "service", label: "Target", render: (r) => r.service || "orchestrator" },
          { key: "active", label: "Validation", render: validation, sort: (a, b) => Number(a.active) - Number(b.active) },
        ],
      }));
}
