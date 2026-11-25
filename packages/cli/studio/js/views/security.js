import { api } from "../api.js";
import { el, icon, Badge, DataTable, EmptyState, KeyValues, MetricCard, Panel } from "../ui.js";
import { Page, DOCS, CommandHint, StackedBar, code } from "./common.js";

const sev = (s) => (s === "critical" || s === "high" ? "bad" : s === "medium" ? "warn" : "neutral");

function Authentication(a, ctx) {
  if (a.configured === false && a.valid === undefined) return EmptyState({ title: "No orchestrator", text: a.reason, iconName: "shield-off" });
  if (a.valid === false) {
    return el("div", { class: "stack" },
      el("p", { class: "callout bad" }, icon("circle-x"), `Security configuration is invalid for "${a.environment}". The orchestrator refuses to start in this state.`),
      el("ul", { class: "plain" }, a.issues.map((i) => el("li", { class: "diag" }, Badge(i.code, "bad"), el("span", {}, i.message), i.key ? code(i.key) : null))),
      el("div", { class: "row wrap" }, CommandHint("pso security:check"), el("a", { class: "doc-link", href: `/docs/${DOCS.security}`, target: "_blank", rel: "noopener" }, icon("book-open"), "Configuration reference")));
  }
  const k = a.authentication.key;
  const cert = a.certificate;
  return el("div", { class: "stack" },
    el("p", { class: "callout ok" }, icon("circle-check"), `The configuration is valid for "${a.environment}". Key providers are verified when the orchestrator starts.`),
    KeyValues([
      ["Provider", a.authentication.provider], ["Issuer", code(a.authentication.issuer)], ["Audience", a.authentication.audiences.join(", ")], ["Algorithms", a.authentication.algorithms.join(", ")],
      ["Key source", k.kind === "jwks" ? el("span", {}, "JWKS ", code(`${k.https ? "https" : "http"}://${k.host}${k.path}`)) : "PEM public key / certificate file"],
      k.kind === "jwks" ? ["JWKS cache / timeout", `${k.cacheTtlSeconds} s / ${k.timeoutMs} ms`] : null,
      k.loopbackException ? ["Loopback exception", Badge("development only", "warn")] : null,
      ["Clock tolerance", `${a.authentication.clockToleranceSeconds} s`], ["Roles claim", code(a.authentication.rolesClaim)], ["Token forwarding", a.propagation?.forward ?? "bearer"],
      ["Certificate", cert?.available ? el("span", {}, Badge(cert.state, cert.state === "valid" ? "ok" : "bad"), ` valid until ${cert.validTo.slice(0, 10)} (${cert.daysLeft} days)`) : el("span", { class: "muted" }, cert?.reason ?? "not available")],
    ]));
}

export async function securityView(ctx) {
  const d = await api.security(ctx.env());
  const c = d.coverage;
  return Page({ title: "Security", question: "How is authentication configured, and which routes are exposed or protected?", docs: { path: DOCS.security, text: "Security docs" } },
    el("p", { class: "callout info" }, icon("info"), d.note),
    el("div", { class: "metrics" },
      MetricCard({ label: "Routes", value: String(c.total), iconName: "route", href: "#/routes" }),
      MetricCard({ label: "Protected", value: String(c.protected), iconName: "lock", tone: "ok", hint: `${c.withScopes} require scopes` }),
      MetricCard({ label: "Public", value: String(c.public), iconName: "lock-open", tone: c.public ? "warn" : "neutral", hint: "no authentication" }),
      MetricCard({ label: "No policy", value: String(c.denied), iconName: "shield-off", tone: c.denied ? "bad" : "ok", hint: "rejected at start-up" })),
    el("div", { class: "cols" },
      Panel({ title: "Authentication", iconName: "key-round", help: "Read from pso.config.json, environment files and PSO_JWT_* variables. Secret values are never shown." }, Authentication(d.authentication, ctx)),
      Panel({ title: "Route security coverage", iconName: "shield-check" },
        StackedBar([{ label: "protected", value: c.protected, tone: "ok" }, { label: "public", value: c.public, tone: "warn" }, { label: "no policy", value: c.denied, tone: "bad" }], "Route security coverage"),
        d.publicRoutes.length ? el("div", {}, el("h3", {}, "Public routes"), el("ul", { class: "plain mono small" }, d.publicRoutes.map((r) => el("li", {}, `${r.method} ${r.path}`)))) : el("p", { class: "muted" }, "No public routes."))),
    Panel({ title: "Authorization policies", iconName: "list-checks" },
      d.policies.length ? DataTable({ caption: "Authorization policies", pageSize: 20, rows: d.policies, columns: [
        { key: "method", label: "Method" }, { key: "path", label: "Endpoint", mono: true }, { key: "module", label: "Module" },
        { key: "access", label: "Authentication", render: (r) => (r.access === "denied" ? Badge("denied", "bad") : Badge(r.access.replace("guard:", ""), "ok")) },
        { key: "scopes", label: "Required scopes", sortable: false, render: (r) => r.scopes.join(", ") || "authenticated only" },
      ] }) : EmptyState({ title: "No protected routes", iconName: "list-checks" })),
    Panel({ title: "Findings", iconName: "triangle-alert", help: "Static checks (pso security:check). Each finding says how to fix it.", actions: CommandHint("pso security:check") },
      d.findings.length ? DataTable({ caption: "Security findings", pageSize: 15, rows: d.findings, columns: [
        { key: "severity", label: "Severity", render: (f) => Badge(f.severity, sev(f.severity)) }, { key: "id", label: "Id", mono: true },
        { key: "resource", label: "Resource", mono: true }, { key: "message", label: "Finding" }, { key: "remediation", label: "How to fix", sortable: false },
      ] }) : el("div", { class: "state empty" }, icon("circle-check", "big"), el("h3", {}, "No findings"), el("p", {}, "The static check reported nothing. That is not a guarantee: review the docs checklist."))));
}
