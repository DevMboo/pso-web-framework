import { api } from "../api.js";
import { el, icon, Badge, Button, DataTable, EmptyState, KeyValues, Panel, StatusIndicator, toast } from "../ui.js";
import { Page, CommandHint, code } from "./common.js";

const sev = (s) => (s === "error" ? "bad" : s === "warning" ? "warn" : "neutral");

/** The distributed frontend of the workspace: the FEI (application shell), its MEIs (microfrontends) and the orchestrator they talk to. */
export async function frontendView(ctx) {
  const d = await api.frontend();
  const ops = await api.frontendOps().catch(() => ({ enabled: false }));
  const relBox = el("div", {}, releasesPanel(ops));
  if (!d.enabled) {
    return Page({ title: "Frontend", question: "How is the distributed frontend (FEI and MEIs) put together?", docs: { path: "frontend/overview.html", text: "FEI and MEI" } },
      EmptyState({ title: "No frontend projects in this workspace", text: "A FEI is the application shell; MEIs are independent business-domain frontends rendered inside it. Create the shell, then one microfrontend per domain.", iconName: "panels-top-left" }),
      el("div", { class: "stack" }, CommandHint("pso create fei <name>"), CommandHint("pso create mei <domain> --register"), CommandHint("pso frontend:dev")));
  }
  const errors = d.diagnostics.filter((x) => x.severity === "error").length, warnings = d.diagnostics.filter((x) => x.severity === "warning").length;
  const feis = d.projects.filter((p) => p.kind === "fei"), fei = feis[0], meis = d.projects.filter((p) => p.kind === "mei");
  const orch = d.graph.nodes.find((n) => n.kind === "orchestrator");
  const dev = (p) => (p.devServerUp ? Badge("dev server up", "ok", `Something answers on port ${p.port}`) : Badge("not running", "neutral", `Nothing answers on port ${p.port}`));

  // 0.2.0: one relationship tree per shell; a MEI belongs to the shell it is built for
  const shellTree = (fe) => el("li", {}, el("div", { class: "row wrap" }, icon("panels-top-left"), el("strong", {}, fe.name), el("span", { class: "mono muted" }, `:${fe.port}`), dev(fe), Badge(fe.auth === "none" ? "no authentication" : "authenticated", fe.auth === "none" ? "neutral" : "ok")),
      el("ul", { class: "plain" },
        ...meis.filter((m) => m.host === fe.name).map((m) => el("li", {}, el("div", { class: "row wrap" }, icon("box"), el("strong", {}, m.name), el("span", { class: "mono muted" }, `:${m.port}`), m.mount ? el("span", { class: "chip mono" }, m.mount) : Badge("not registered", "warn"), m.public ? Badge(Array.isArray(m.public) ? `public: ${m.public.join(", ")}` : "public", "neutral") : null, dev(m),
          m.scopes.length ? el("span", { class: "muted small" }, `scopes: ${m.scopes.join(", ")}`) : null))),
        orch ? el("li", {}, el("div", { class: "row wrap" }, icon("server"), el("strong", {}, orch.label), el("span", { class: "muted" }, "orchestrator: the only backend the browser reaches"))) : null));
  const orphans = meis.filter((m) => !feis.some((fe) => fe.name === m.host));
  const tree = el("ul", { class: "plain", "aria-label": "Frontend dependency graph" }, ...(feis.length ? feis.map(shellTree) : [el("li", {}, "(no FEI)")]), ...orphans.map((m) => el("li", {}, Badge(`${m.name}: host ${m.host} is not a FEI`, "bad"))));

  return Page({ title: "Frontend", question: "How is the distributed frontend (FEI and MEIs) put together, and is it consistent?", docs: { path: "frontend/studio.html", text: "Frontend in Studio" },
    actions: [Button({ label: "Re-validate", iconName: "refresh-cw", onclick: async () => { const r = await api.frontend({ fresh: 1 }); const e = r.diagnostics.filter((x) => x.severity === "error").length; toast(e ? `${e} error(s)` : "Frontend declarations are valid", e ? "bad" : "ok"); ctx.rerender(); } })] },
    ops.enabled ? null : el("p", { class: "callout info" }, icon("shield-check"), "Read-only, like the rest of local Studio: it shows the declarations and which development servers answer. Start Studio with `pso studio --frontend-ops` to validate, build, start and stop development servers and publish or roll back to the local site from this page; remote deployment is the Cloud section."),
    ops.enabled ? operationsPanel(ctx, d, ops, (s) => relBox.replaceChildren(releasesPanel(s))) : null,
    relBox,
    Panel({ title: "Relationships", iconName: "network" }, tree),
    Panel({ title: "Status", iconName: "activity" }, KeyValues([
      ["Validation", errors ? Badge(`${errors} error(s)`, "bad") : warnings ? Badge(`valid, ${warnings} warning(s)`, "warn") : Badge("valid", "ok")],
      ["Shells (FEI)", String(feis.length)], ["Microfrontends", String(meis.length)], ["Effective routes", String(d.routes.length)],
      ["Middleware order", fei && fei.middlewares ? el("span", { class: "mono" }, fei.middlewares.join(" > ")) : "-"],
      ["Authentication", fei ? fei.auth : "-"],
      ["Orchestrator contract", d.contract ? el("span", {}, code(d.contract.current), " ", d.contract.projects.every((p) => p.version === null || p.version === d.contract.current) ? Badge("projects current", "ok") : Badge("a project is stale", "warn")) : "orchestrator not analyzable"],
    ])),
    Panel({ title: "Route ownership", iconName: "route" }, DataTable({ caption: "Effective browser routes and the project that owns each", columns: [
      ...(feis.length > 1 ? [{ key: "app", label: "Shell" }] : []), { key: "path", label: "Route", render: (r) => code(r.path) }, { key: "owner", label: "Owner" },
      { key: "target", label: "Page / redirect", render: (r) => (r.redirect ? `redirects to ${r.redirect}` : r.page ?? "") }, { key: "scopes", label: "Scopes", render: (r) => (r.scopes.length ? r.scopes.join(", ") : "-") }],
    rows: d.routes, pageSize: 15, empty: "No routes declared" })),
    Panel({ title: "Diagnostics", iconName: "stethoscope" }, d.diagnostics.length === 0
      ? el("p", { class: "muted" }, "No findings. Browser-side checks are user-experience only: the orchestrator enforces every scope, tenant and business rule.")
      : el("ul", { class: "diag-list" }, d.diagnostics.map((x) => el("li", { class: "diag-card" }, el("div", { class: "row wrap" }, Badge(x.severity, sev(x.severity)), el("strong", { class: "mono" }, x.code), x.file ? el("span", { class: "mono muted" }, x.file) : null), el("pre", { class: "diag-text" }, x.message), x.hint ? el("p", {}, icon("lightbulb"), " ", x.hint) : null)))),
    Panel({ title: "Operate from the CLI", iconName: "terminal" }, el("div", { class: "stack" }, CommandHint("pso frontend:dev"), CommandHint("pso frontend:build --base-path /app/"), CommandHint("pso frontend:publish <mei> --site <dir>"), CommandHint("pso frontend:rollback <mei> --site <dir>"), CommandHint("pso frontend:releases --site <dir>"))));
}

// ---- operations (only when Studio was started with --frontend-ops). Every action runs the same `pso frontend:*` command a developer would type.
const field = (label, input, hint) => el("label", { class: "field stacked" }, el("span", {}, label), input, hint ? el("small", { class: "muted" }, hint) : null);
const run = async (btn, fn) => { btn?.setAttribute("disabled", ""); try { return await fn(); } catch (e) { toast(e.message, "bad"); throw e; } finally { btn?.removeAttribute("disabled"); } };

function operationsPanel(ctx, d, ops, onStatus) {
  const projects = d.projects.map((p) => p.name);
  const project = el("select", { "aria-label": "Project" }, el("option", { value: "" }, "(all projects)"), ...projects.map((n) => el("option", { value: n }, n)));
  const basePath = el("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "/ or /commerce/", "aria-label": "Base path", value: "/" });
  const confirm = el("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "publish mei-customers", "aria-label": "Type the action and project to confirm" });
  const out = el("pre", { class: "diag-text", "aria-live": "polite", "aria-label": "Output of the last operation" }, ops.last ? ops.last.output : "No operation has run yet.");
  const log = el("pre", { class: "diag-text", "aria-label": "Development server log" }, ops.dev.log.join("\n") || "(the development servers are not running)");
  const state = el("div", { class: "row wrap" });
  const paint = (s) => {
    state.replaceChildren(...[s.dev.running ? Badge("development servers running (pid " + s.dev.pid + ")", "ok") : Badge("development servers stopped", "neutral"), s.busy ? Badge("running: " + s.busy, "warn") : null, s.last ? Badge("last: " + s.last.action + (s.last.project ? " " + s.last.project : "") + (s.last.ok ? " ok" : " failed (" + s.last.exitCode + ")"), s.last.ok ? "ok" : "bad") : null].filter(Boolean));
    log.textContent = s.dev.log.join("\n") || "(the development servers are not running)";
    if (s.last) out.textContent = s.last.output;
  };
  paint(ops);
  const refresh = async () => { const s = await api.frontendOps(); paint(s); onStatus(s); };
  const act = (action, label, iconName, extra = {}) => Button({ label, iconName, variant: extra.variant ?? "", onclick: (e) => run(e.currentTarget, async () => {
    const body = { action, ...(project.value ? { project: project.value } : {}), ...(basePath.value && basePath.value !== "/" ? { basePath: basePath.value } : {}), ...(extra.confirm ? { confirm: confirm.value.trim() } : {}) };
    const r = await api.frontendOp(body);
    if (r.output !== undefined) { out.textContent = r.output; toast(label + (r.ok ? " finished" : " failed"), r.ok ? "ok" : "bad"); } else toast(label + ": done");
    await refresh();
  }) });
  return Panel({ title: "Operations", iconName: "wrench" },
    el("div", { class: "stack" },
      el("p", { class: "callout warn" }, icon("shield-alert"), "These actions run on this machine, in this workspace, through the same CLI commands. Publishing and rolling back write to the local site root (.pso/studio-site); deploying to a server is the Cloud section."),
      state,
      el("div", { class: "grid-2" }, field("Project", project), field("Base path (build, publish)", basePath)),
      el("div", { class: "row wrap" }, act("validate", "Validate", "check-check"), act("build", "Build", "hammer"), act("dev-start", "Start dev servers", "play"), act("dev-stop", "Stop", "square"), act("dev-restart", "Restart", "rotate-cw"), Button({ label: "Refresh", iconName: "refresh-cw", variant: "ghost", onclick: (e) => run(e.currentTarget, refresh) })),
      field("Confirmation for publish and rollback", confirm, 'Type the action and the project, for example "publish mei-customers" or "rollback mei-customers"'),
      el("div", { class: "row wrap" }, act("publish", "Publish to local site", "upload", { confirm: true }), act("rollback", "Roll back on local site", "undo-2", { confirm: true })),
      el("h4", {}, "Output of the last operation"), out,
      el("h4", {}, "Development server log"), log));
}

function releasesPanel(ops) {
  const r = ops.releases;
  const rows = r ? [...(r.fei ? [{ name: "FEI (shell)", active: r.fei.active, versions: r.fei.versions, last: r.fei.history.at(-1) }] : []), ...r.meis.map((m) => ({ name: m.name, active: m.active, versions: m.versions, last: m.history.at(-1) }))] : [];
  return Panel({ title: "Active frontend releases (local site)", iconName: "package-check" }, rows.length
    ? DataTable({ caption: "Published versions on the local site root and which one is active", columns: [
      { key: "name", label: "Project" }, { key: "active", label: "Active", render: (x) => (x.active ? Badge(x.active, "ok") : Badge("none", "neutral")) },
      { key: "versions", label: "Published versions", render: (x) => code(x.versions.join(", ")) }, { key: "last", label: "Last change", render: (x) => (x.last ? x.last.action + " " + x.last.version + " (" + x.last.at.slice(0, 19).replace("T", " ") + ")" : "-") }], rows, pageSize: 10 })
    : el("p", { class: "muted" }, "Nothing has been published to the local site yet. Deployed releases on servers are shown by the Cloud section (pso release:status <frontend deployment>)."));
}
