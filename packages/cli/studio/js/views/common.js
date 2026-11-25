import { el, icon, docsLink } from "../ui.js";

/** Standard page frame: title, one-sentence purpose (every screen answers a developer question), actions, then content. */
export function Page({ title, question, actions, docs }, ...body) {
  return el("div", { class: "page" },
    el("header", { class: "page-head" },
      el("div", {}, el("h1", {}, title), question ? el("p", { class: "lede" }, question) : null),
      el("div", { class: "page-actions" }, docs ? docsLink(docs.path, docs.text ?? "Docs") : null, actions ?? null)),
    ...body);
}

export const DOCS = {
  routes: "orchestrator/routes.html",
  modules: "orchestrator/module.html",
  security: "security/security-configuration.html",
  authentication: "security/authentication.html",
  authorization: "security/authorization.html",
  dispatch: "dispatch/overview.html",
  config: "concepts/configuration.html",
  diagnostics: "reference/diagnostics.html",
  logs: "security/auditing.html",
  services: "microservices/service-to-service.html",
  observability: "devops/docker.html",
};
export const cliDoc = (cmd) => `cli/${cmd.replace(/^pso\s+/, "").split(/\s+/)[0].replace(/:/g, "-")}.html`;

export const code = (t) => el("code", { class: "mono inline" }, t);
export const section = (...kids) => el("div", { class: "stack" }, ...kids);

export function CommandHint(cmd) {
  return el("span", { class: "cmd-hint" }, icon("terminal"), code(cmd), el("a", { class: "doc-link", href: `/docs/${cliDoc(cmd)}`, target: "_blank", rel: "noopener" }, "reference"));
}

/** Horizontal stacked bar for categorical counts. Only real counts are passed in. Each segment has text in the legend (not color only). */
export function StackedBar(parts, label) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const bar = el("div", { class: "stackbar", role: "img", "aria-label": `${label}: ${parts.map((p) => `${p.value} ${p.label}`).join(", ")}` });
  if (total === 0) bar.append(el("span", { class: "seg none" }));
  for (const p of parts) if (p.value > 0) { const seg = el("span", { class: `seg ${p.tone}`, title: `${p.label}: ${p.value}` }); seg.style.setProperty("flex-grow", String(p.value)); bar.append(seg); }
  return el("div", {}, bar, el("ul", { class: "legend" }, parts.map((p) => el("li", {}, el("span", { class: `swatch ${p.tone}` }), `${p.label} ${p.value}`))));
}
