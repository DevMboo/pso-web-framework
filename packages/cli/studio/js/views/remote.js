// Remote hosts and deployments: registered connections (references only), host capabilities and prerequisites, the active release,
// container health, history, logs, and (with --ops, typed confirmation) deploy, rollback and unlock run as jobs whose progress is polled.
import { api } from "../api.js";
import { el, icon, Badge, Button, DataTable, EmptyState, KeyValues, Panel, toast } from "../ui.js";
import { Page, CommandHint, code } from "./common.js";

const sev = (s) => (s === "error" ? "bad" : s === "warning" ? "warn" : "neutral");
const store = { get: () => { try { return sessionStorage.getItem("pso-studio-remote-env") ?? ""; } catch { return ""; } }, set: (v) => { try { sessionStorage.setItem("pso-studio-remote-env", v); } catch { /* blocked */ } } };

export async function remoteView(ctx) {
  const h = await api.remote.hosts();
  if (h.error) return Page({ title: "Remote hosts" }, el("p", { class: "callout bad" }, h.error));
  const connections = Panel({ title: "Registered hosts", iconName: "server-cog", help: "Registered with pso connection:add: the host key is pinned and the credential is a key file path, the SSH agent or a reference in PSO's credential store. Nothing secret is shown here." },
    h.connections.length ? DataTable({ caption: "Connections", columns: [{ key: "name", label: "Name", render: (c) => code(c.name) }, { key: "target", label: "Host", render: (c) => code(`${c.user}@${c.host}:${c.port}`) }, { key: "auth", label: "Authentication", render: (c) => (typeof c.auth === "object" ? c.auth.kind ?? "-" : c.auth ?? "-") }, { key: "hostKeyFingerprint", label: "Pinned host key", render: (c) => (c.hostKeyFingerprint ? el("span", { class: "mono small" }, c.hostKeyFingerprint) : Badge("not pinned", "bad")) }], rows: h.connections }) : EmptyState({ title: "No host registered", text: "Register a Linux host reachable over SSH; its host key is approved and pinned.", iconName: "server-cog", action: CommandHint("pso connection:add staging --host <host> --user <user> --auth agent --accept-host-key <SHA256:...>") }));
  if (!h.environments.length) return Page({ title: "Remote hosts", question: "Which hosts can PSO deploy to, and what runs there?", docs: { path: "infrastructure/remote-hosts.html", text: "Remote hosts" } }, connections, el("p", { class: "callout info" }, icon("info"), "No environment deploys over SSH yet: set deploy: { target: \"ssh\", connection: \"<name>\" } in pso.infra.json."));
  const current = h.environments.some((e) => e.name === store.get()) ? store.get() : h.environments[0].name;
  const picker = el("label", { class: "field" }, el("span", { class: "muted small" }, "Environment"), el("select", { "aria-label": "Remote environment", onchange: (e) => { store.set(e.target.value); ctx.rerender(); } }, h.environments.map((e) => el("option", { value: e.name, ...(e.name === current ? { selected: true } : {}) }, `${e.name} → ${e.connection}`))));
  const body = el("div", { class: "stack" }, el("p", { class: "muted" }, `Contacting the host of "${current}" over SSH…`));
  const out = Page({ title: "Remote hosts", question: "Which hosts can PSO deploy to, can they run this environment, and what runs there now?", docs: { path: "infrastructure/remote-hosts.html", text: "Remote hosts" }, actions: [picker] }, connections, body);
  void (async () => {
    const d = await api.remote.environment(current).catch((e) => ({ error: e.message }));
    if (d.error) { body.replaceChildren(el("p", { class: "callout bad" }, icon("circle-x"), d.error)); return; }
    const f = d.facts, s = d.status;
    const logBox = el("pre", { class: "log-view", tabindex: "0" }, "Select a container to read its log on the host (secrets masked).");
    const svc = el("select", { "aria-label": "Container" }, s.containers.map((c) => el("option", { value: c.service }, c.service)));
    const progress = el("pre", { class: "log-view", "aria-live": "polite", hidden: true });
    const confirmOp = (action, label, variant = "") => {
      const input = el("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: `${action} ${current}`, "aria-label": `Type "${action} ${current}" to confirm` });
      const b = Button({ label, iconName: action === "deploy" ? "rocket" : action === "rollback" ? "history" : "lock-open", variant, onclick: async () => {
        if (input.value.trim() !== `${action} ${current}`) { toast(`Type "${action} ${current}" to confirm`, "bad"); input.focus(); return; }
        b.setAttribute("disabled", "");
        try {
          const { job } = await api.remote.op({ action, env: current, confirm: input.value.trim() });
          progress.hidden = false; progress.textContent = "";
          for (;;) { await new Promise((r) => setTimeout(r, 2000)); const j = await api.remote.job(job); progress.textContent = j.lines.join("\n"); progress.scrollTop = progress.scrollHeight; if (j.state !== "running") { toast(j.state === "succeeded" ? `${action}: done` : `${action} failed: ${j.error}`, j.state === "succeeded" ? "ok" : "bad"); break; } }
          ctx.rerender();
        } catch (e) { toast(e.message, "bad"); } finally { b.removeAttribute("disabled"); input.value = ""; }
      } });
      return el("div", { class: "row wrap" }, input, b);
    };
    body.replaceChildren(
      Panel({ title: `Host ${d.host}`, iconName: "server" }, KeyValues([["System", `${f.os}, ${f.arch}, kernel ${f.kernel}`], ["Docker", f.docker ? `${f.docker} (compose ${f.compose ?? "missing"})` : Badge("not available", "bad")], ["Root", `${f.root} (${f.rootWritable ? "writable" : "NOT writable"}, ${f.diskFreeMb ?? "?"} MB free)`], ["Listening ports", f.listening.join(", ") || "-"], ["Managed deployments", f.deployments.map((x) => `${x.project}${x.release ? ` (${x.release})` : ""}`).join(", ") || "none"], ["Registry", f.registry === "reachable" ? "Docker Hub resolvable" : "not resolvable (images are transferred over SSH)"]])),
      Panel({ title: "Prerequisites of this environment", iconName: "shield-check" }, el("ul", { class: "diag-list" }, d.findings.map((x) => el("li", { class: "diag-card" }, el("div", { class: "row wrap" }, Badge(x.severity, sev(x.severity)), el("strong", { class: "mono" }, x.check)), el("p", {}, x.message))))),
      Panel({ title: "Running release", iconName: "activity" }, KeyValues([["Active release", s.current ? code(s.current) : "none"], ["Lock", s.locked ? Badge(`locked by ${s.locked}`, "warn") : "free"]]),
        DataTable({ caption: "Containers on the host", columns: [{ key: "service", label: "Container" }, { key: "state", label: "State", render: (c) => Badge(c.state, c.state === "running" ? "ok" : "warn") }, { key: "health", label: "Health", render: (c) => (c.health ? Badge(c.health, c.health === "healthy" ? "ok" : "bad") : "-") }, { key: "status", label: "Status" }], rows: s.containers, empty: "No container of this environment on the host" })),
      Panel({ title: "History", iconName: "history" }, s.history.length ? DataTable({ caption: "Deployments and rollbacks", columns: [{ key: "at", label: "When" }, { key: "action", label: "Action" }, { key: "release", label: "Release", render: (x) => code(x.release) }, { key: "previous", label: "Previous", render: (x) => (x.previous ? code(x.previous) : "-") }, { key: "reason", label: "Reason", render: (x) => x.reason ?? "" }], rows: [...s.history].reverse() }) : el("p", { class: "muted" }, "No deployment recorded on this host yet.")),
      Panel({ title: "Logs", iconName: "scroll-text", actions: [Button({ label: "Show", iconName: "refresh-cw", variant: "ghost", onclick: async () => { logBox.textContent = "loading…"; const r = await api.remote.logs(current, svc.value, 200); logBox.textContent = r.error ? r.error : r.lines.join("\n") || "(empty)"; } })] }, el("div", { class: "row wrap" }, svc), logBox),
      h.opsEnabled ? Panel({ title: "Operations", iconName: "rocket", help: "Deploy builds here, transfers only what the host lacks, verifies every checksum on the host, starts, probes through an SSH tunnel and activates — or starts the previous release again. Volumes and databases are kept; database migrations are never reverted." },
        el("div", { class: "stack" }, el("div", {}, el("strong", {}, "Deploy"), confirmOp("deploy", "Deploy")), el("div", {}, el("strong", {}, "Roll back to the previous release"), confirmOp("rollback", "Roll back", "ghost")), ...(s.locked ? [el("div", {}, el("strong", {}, "Remove a stale lock"), confirmOp("unlock", "Unlock", "ghost"))] : []), progress))
        : el("p", { class: "callout info" }, icon("shield-check"), "Read-only: start Studio with `pso studio --ops` to deploy and roll back from here (each needs a typed confirmation)."),
      Panel({ title: "From the CLI", iconName: "terminal" }, el("div", { class: "stack" }, CommandHint(`pso host:check --env ${current}`), CommandHint(`pso deploy --env ${current} --dry-run`), CommandHint(`pso deploy:status --env ${current}`), CommandHint(`pso rollback --env ${current} --yes`))));
  })();
  return out;
}
