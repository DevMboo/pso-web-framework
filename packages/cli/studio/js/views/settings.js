import { api } from "../api.js";
import { el, icon, Badge, DataTable, EmptyState, KeyValues, Panel, SelectFilter } from "../ui.js";
import { Page, DOCS, CommandHint, code } from "./common.js";

const ENVS = ["development", "test", "staging", "production"];

export async function settingsView(ctx) {
  const env = ctx.env();
  const d = await api.environments(env);
  const cur = d.environments.find((e) => e.env === env);
  return Page({ title: "Settings", question: "Where does each setting come from, and is the configuration valid for this environment?", docs: { path: DOCS.config, text: "Configuration docs" } },
    el("p", { class: "callout info" }, icon("lock"), "Studio is read-only: it never writes configuration. Values of secret-looking keys are masked by the server and never leave the process."),
    el("div", { class: "toolbar" },
      SelectFilter({ label: "Environment", value: env, options: ENVS.map((e) => [e, e]), onchange: (v) => ctx.setEnv(v) }),
      el("div", { class: "field" }, el("span", {}, "Studio"), el("div", { class: "row" }, Badge("read-only", "ok"), Badge("loopback only", "ok"), Badge("token required", "ok")))),
    el("div", { class: "cols" },
      Panel({ title: `Validation: ${env}`, iconName: "shield-check" },
        cur.validation.status === "valid" ? el("p", { class: "callout ok" }, icon("circle-check"), "The security configuration validates for this environment.")
          : cur.validation.status === "not-applicable" ? el("p", { class: "muted" }, "There is no orchestrator whose security configuration could be validated.")
            : el("div", { class: "stack" }, el("p", { class: "callout bad" }, icon("circle-x"), `${cur.validation.issues.length} problem(s) in the security configuration.`),
              el("ul", { class: "plain" }, cur.validation.issues.map((i) => el("li", { class: "diag" }, Badge(i.code, "bad"), el("span", {}, i.message), i.key ? code(i.key) : null)))),
        cur.missing.length ? el("p", {}, "Missing required settings: ", cur.missing.map((m) => el("span", { class: "chip mono" }, m))) : null,
        el("div", { class: "row wrap" }, CommandHint("pso config:validate"))),
      Panel({ title: "Precedence", iconName: "layers", help: "Later layers override earlier ones." }, el("ol", { class: "precedence" }, d.precedence.map((l, i) => el("li", {}, el("span", { class: "mono" }, l), i === d.precedence.length - 1 ? el("span", { class: "muted" }, " (highest)") : null))))),
    Panel({ title: "Configuration sources", iconName: "files", help: "Environment variable names are never listed with values; only whether a layer is present." },
      DataTable({ caption: "Configuration sources", rows: cur.sources, pageSize: 20, columns: [{ key: "layer", label: "Layer" }, { key: "source", label: "Source", mono: true }, { key: "present", label: "State", render: (s) => (s.present ? Badge("present", "ok") : Badge("absent", "idle")) }] })),
    ...d.scopes.map((sc) => Panel({ title: `Resolved values: ${sc.scope}`, iconName: "settings" }, sc.values.length
      ? DataTable({ caption: `Resolved values for ${sc.scope}`, rows: [...sc.values].sort((x, y) => Number(x.origin === "defaults") - Number(y.origin === "defaults") || (x.key < y.key ? -1 : 1)), pageSize: 20, columns: [{ key: "key", label: "Key", mono: true }, { key: "value", label: "Value", mono: true, render: (v) => JSON.stringify(v.value) }, { key: "origin", label: "Origin" }] })
      : el("p", { class: "muted" }, "No explicit values: built-in defaults apply."))));
}
