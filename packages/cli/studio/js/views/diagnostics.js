import { api } from "../api.js";
import { el, icon, Badge, Button, CopyButton, DataTable, EmptyState, Panel, SelectFilter, toast } from "../ui.js";
import { Page, DOCS, CommandHint } from "./common.js";

const state = { source: "", severity: "" };
const tone = (s) => (s === "error" || s === "critical" || s === "high" ? "bad" : s === "warning" || s === "medium" ? "warn" : "neutral");

export async function diagnosticsView(ctx) {
  const d = await api.diagnostics();
  const items = d.items.filter((i) => (!state.source || i.source === state.source) && (!state.severity || tone(i.severity) === state.severity));
  const sources = [...new Set(d.items.map((i) => i.source))];
  const text = (i) => `[${i.severity}] ${i.code} (${i.source})${i.file ? ` ${i.file}` : ""}\n${i.message}${i.hint ? `\nFix: ${i.hint}` : ""}`;
  return Page({ title: "Diagnostics", question: "What is wrong, why, and how do I fix it?", docs: { path: DOCS.diagnostics, text: "Error codes" },
    actions: [
      Button({ label: "Re-validate", iconName: "refresh-cw", onclick: async () => { const r = await api.diagnostics({ fresh: 1 }); toast(r.total ? `${r.total} diagnostic(s)` : "No diagnostics", r.total ? "warn" : "ok"); ctx.rerender(); } }),
      CopyButton(async () => (await api.aiContext()).markdown, "Copy AI context")] },
    el("p", { class: "callout info" }, icon("bot"), "\"Copy AI context\" copies a sanitized summary (structure, routes and diagnostics). It never includes tokens, keys, passwords or secret values."),
    el("div", { class: "toolbar" },
      SelectFilter({ label: "Source", value: state.source, options: [["", "All sources"], ...sources.map((s) => [s, s])], onchange: (v) => { state.source = v; ctx.rerender(); } }),
      SelectFilter({ label: "Severity", value: state.severity, options: [["", "All"], ["bad", "Errors / high"], ["warn", "Warnings / medium"], ["neutral", "Info / low"]], onchange: (v) => { state.severity = v; ctx.rerender(); } })),
    d.total === 0
      ? el("div", { class: "state empty" }, icon("circle-check", "big"), el("h3", {}, "No diagnostics"), el("p", {}, "Route validation, static security checks and security configuration reported nothing. Absence of findings is not proof of correctness."))
      : el("ul", { class: "diag-list" }, items.map((i) => el("li", { class: "diag-card" },
        el("div", { class: "row wrap" }, Badge(i.severity, tone(i.severity)), el("strong", { class: "mono" }, i.code), Badge(i.source, "neutral"), i.file ? el("span", { class: "mono muted" }, i.file) : null),
        el("pre", { class: "diag-text" }, i.message), i.hint ? el("p", {}, icon("lightbulb"), " ", i.hint) : null,
        el("div", { class: "row wrap" }, i.docs ? el("a", { class: "doc-link", href: `/docs/${i.docs}`, target: "_blank", rel: "noopener" }, icon("book-open"), "Documentation") : null, i.command ? CommandHint(i.command) : null, CopyButton(() => text(i), "Copy"))))));
}
