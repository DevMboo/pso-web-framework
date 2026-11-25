// Cloud: environments, connections, deployments, pipelines, infrastructure, credentials and audit for remote servers.
// Everything shown here comes from the Studio server, which talks to the agents through the same operational engine as the CLI.
// Nothing is simulated: live data (releases, resources, services) is read from the server when you ask, and the page says when it has not been read.
// The browser never receives credentials: secrets typed here go to the local Studio process once and are stored in the protected credential store.
import { api } from "../api.js";
import { el, icon, Badge, Button, CopyButton, DataTable, EmptyState, ErrorState, KeyValues, MetricCard, Panel, Skeleton, closeDrawer, fmtTime, openDrawer, setVar, toast } from "../ui.js";
import { Page, CommandHint, code } from "./common.js";
import { applicationsTab, endpointsTab, servicesTab, nginxTab, networkTab } from "./cloud-ops.js";

const TABS = [["overview", "layout-dashboard", "Overview"], ["applications", "app-window", "Applications"], ["environments", "layers", "Environments"], ["connections", "plug", "Connections"], ["deployments", "rocket", "Deployments"], ["endpoints", "route", "Endpoints"], ["services", "cpu", "Services"], ["pipelines", "workflow", "Pipelines"], ["infrastructure", "server-cog", "Infrastructure"], ["nginx", "network", "NGINX"], ["network", "shield-alert", "Network"], ["credentials", "key-round", "Credentials"], ["signing", "badge-check", "Signing"], ["audit", "scroll-text", "Audit"]];

// ---------------------------------------------------------------- small shared pieces
const ENV_TONE = { production: "bad", staging: "warn", development: "ok", testing: "idle", local: "idle" };
/** The environment is always named in words: production is never distinguished by color alone. */
export const EnvPill = (env) => el("span", { class: `pill env-pill ${ENV_TONE[env] ?? "idle"}${env === "production" ? " prod" : ""}`, title: env === "production" ? "Production: actions here affect live users" : `Environment ${env}` }, icon(env === "production" ? "triangle-alert" : "server"), env);
const STATE_TONE = { COMPLETED: "ok", FAILED: "bad", INTERRUPTED: "bad", ROLLED_BACK: "warn", CANCELLED: "idle" };
const StatePill = (s) => el("span", { class: `pill ${STATE_TONE[s] ?? "info"}` }, icon(s === "COMPLETED" ? "circle-check" : ["FAILED", "INTERRUPTED"].includes(s) ? "circle-x" : s === "ROLLED_BACK" ? "undo-2" : s === "CANCELLED" ? "circle-pause" : "loader-circle", ["REQUESTED", "PLANNING", "VALIDATING", "PREPARING", "BUILDING", "STARTING_CANDIDATE", "VERIFYING_CANDIDATE", "SWITCHING_TRAFFIC", "VERIFYING_ACTIVE_RELEASE", "DRAINING_PREVIOUS_RELEASE", "RECOVERING"].includes(s) ? "spin" : ""), s.replaceAll("_", " ").toLowerCase());
const STAGE = { passed: ["circle-check", "ok"], failed: ["circle-x", "bad"], skipped: ["circle-minus", "idle"], disabled: ["toggle-left", "warn"], unavailable: ["circle-help", "warn"], running: ["loader-circle", "info"], pending: ["circle-dashed", "idle"], blocked: ["ban", "bad"], "awaiting-approval": ["hourglass", "warn"], cancelled: ["circle-pause", "idle"] };
const isRunning = (s) => !["COMPLETED", "FAILED", "CANCELLED", "ROLLED_BACK", "INTERRUPTED"].includes(s);

function Pipeline(stages, empty = "No stages recorded yet.") {
  if (!stages?.length) return el("p", { class: "muted" }, empty);
  return el("ol", { class: "pipeline", "aria-label": "Pipeline stages" }, stages.map((s) => {
    const st = s.status ?? (s.enabled === false ? "disabled" : "pending"); const [ic, tone] = STAGE[st] ?? STAGE.pending;
    return el("li", { class: `stage ${tone}`, "data-status": st }, icon(ic, st === "running" ? "spin" : ""), el("div", {}, el("strong", {}, s.id ?? s.type), el("span", { class: "stage-status" }, st.replace("-", " ")), s.detail || s.reason ? el("small", {}, s.detail ?? s.reason) : null));
  }));
}

/** Blue-green view from REAL deployment fields: which release holds traffic right now, according to the deployment's recorded state. */
function BlueGreen(d) {
  const switched = !!d.trafficSwitched || d.state === "COMPLETED" || d.state === "DRAINING_PREVIOUS_RELEASE";
  const failed = ["FAILED", "CANCELLED", "ROLLED_BACK"].includes(d.state);
  const toCandidate = switched && !(failed && d.state !== "COMPLETED");
  const box = (title, release, role, live) => el("div", { class: `bg-box ${live ? "live" : ""}` }, el("span", { class: "bg-role" }, role), el("strong", {}, title), el("code", { class: "mono small" }, release ?? "none"), live ? Badge("receiving traffic", "ok") : Badge("not receiving traffic", "idle"));
  return el("div", { class: "bluegreen", role: "group", "aria-label": `${d.strategy} deployment: traffic goes to ${toCandidate ? "the new release" : "the previous release"}` },
    box("Previous release", d.previousRelease, "active before", !toCandidate), el("div", { class: `bg-arrow ${toCandidate ? "to-new" : "to-old"}`, "aria-hidden": "true" }, icon("arrow-right-left")), box(d.kind === "rollback" ? "Restored release" : "Candidate release", d.releaseId, d.strategy, toCandidate));
}

const FailureHelp = (e) => el("p", { class: "callout bad" }, icon("circle-x"), e.message);
async function run(button, fn) {
  button?.setAttribute("disabled", ""); try { return await fn(); } catch (e) { toast(e.message, "bad"); throw e; } finally { button?.removeAttribute("disabled"); }
}
const field = (label, input, hint) => el("label", { class: "field stacked" }, el("span", {}, label), input, hint ? el("small", { class: "muted" }, hint) : null);
/** deployments are addressed by their unique application name; the production safeguards follow the REAL environment of that deployment */
const ENV_OF = {};
const confirmBox = (env) => { const real = ENV_OF[env] ?? env; const i = el("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: real, "aria-label": `Type ${real} to confirm`, value: real === "production" || real === "staging" ? "" : real }); return { node: field(`Type "${real}" to confirm`, i, real === "production" ? "This is a production environment." : undefined), value: () => i.value.trim() }; };

// ---------------------------------------------------------------- deployment drawer (live)
function openDeployment(env, id, ctx) {
  const body = el("div", { class: "stack" }, Skeleton(3)); let timer; let stopped = false;
  const actions = el("div", { class: "row wrap" });
  const d = openDrawer({ title: `Deployment ${id}`, subtitle: `${env} · read from the server`, body, actions });
  const stop = () => { stopped = true; clearTimeout(timer); };
  new MutationObserver((_, o) => { if (!document.contains(d)) { stop(); o.disconnect(); } }).observe(document.getElementById("drawer-host"), { childList: true });
  const tick = async () => {
    if (stopped) return;
    try {
      const x = await api.cloud.deployment(env, id); const logs = await api.cloud.env(env, "logs", { deployment: id }).catch(() => ({ text: "" }));
      const conf = confirmBox(env);
      actions.replaceChildren(
        isRunning(x.effectiveState) && !x.trafficSwitched ? Button({ label: "Cancel", iconName: "ban", variant: "ghost", onclick: async (e) => { await run(e.currentTarget, () => api.cloud.envPost(env, "cancel", { deployment: id, confirm: env })); toast("Cancellation requested"); } }) : null,
        x.effectiveState === "INTERRUPTED" ? Button({ label: "Recover", iconName: "rotate-ccw", onclick: async (e) => { const r = await run(e.currentTarget, () => api.cloud.envPost(env, "recover", { confirm: env })); toast(`${r.action}: ${r.note}`); } }) : null);
      body.replaceChildren(
        el("div", { class: "row wrap" }, StatePill(x.effectiveState), Badge(x.kind), Badge(x.strategy), x.recovered ? Badge("recovered", "warn") : null, el("span", { class: "muted small" }, `by ${x.requestedBy?.name ?? "?"} · started ${fmtTime(x.startedAt)}${x.finishedAt ? ` · ended ${fmtTime(x.finishedAt)}` : ""}`)),
        x.effectiveState === "INTERRUPTED" ? el("p", { class: "callout warn" }, icon("triangle-alert"), "The worker on the server is gone. Nothing was replayed. Use Recover to reconcile from what really exists.") : null,
        x.strategy === "blue-green" || x.kind === "rollback" ? BlueGreen(x) : el("p", { class: "muted" }, `Strategy ${x.strategy}: ${x.strategy === "recreate" ? "the running release is stopped before the new one starts." : "instances are replaced one at a time."}`),
        Panel({ title: "Pipeline", iconName: "workflow" }, Pipeline(x.stages)),
        x.availability ? el("p", { class: "callout ok" }, icon("activity"), `Active-release verification through the proxy: ${x.availability.requests - x.availability.failures} of ${x.availability.requests} probes reached the new release.`) : null,
        x.error ? FailureHelp({ message: x.error }) : null,
        Panel({ title: "Log (sanitized, from the server)", iconName: "scroll-text", actions: CopyButton(() => logs.text) }, el("pre", { class: "logbox", tabindex: "0" }, logs.text || "(empty)")));
      if (!isRunning(x.effectiveState)) { stop(); return; }
    } catch (e) { body.replaceChildren(FailureHelp(e)); }
    timer = setTimeout(tick, 1500);
  };
  tick();
}

// ---------------------------------------------------------------- plan drawer
function PlanView(plan, env, ctx) {
  const conf = confirmBox(env);
  const blocked = plan.blockers.length > 0;
  const approveBtn = plan.approvalsRequired > 0 ? Button({ label: "Approve plan", iconName: "badge-check", onclick: async (e) => { const r = await run(e.currentTarget, () => api.cloud.envPost(env, "approve", { planHash: plan.hash })); toast(`Approved: ${r.approvals} of ${r.required}`); } }) : null;
  const deployBtn = Button({ label: `Deploy to ${env}`, iconName: "rocket", variant: env === "production" ? "danger" : "primary", disabled: blocked, onclick: async (e) => {
    const d = await run(e.currentTarget, () => api.cloud.envPost(env, "deploy", { planHash: plan.hash, confirm: conf.value() }));
    toast(`Deployment ${d.id} started on the server`); closeDrawer(false); openDeployment(env, d.id, ctx);
  } });
  return el("div", { class: "stack" },
    el("div", { class: "row wrap" }, EnvPill(plan.environment), Badge(plan.strategy.type), Badge(`plan ${plan.hash.slice(0, 12)}`, "neutral", plan.hash), plan.availability.impact === "downtime" ? Badge("downtime expected", "bad") : Badge("no downtime expected", "ok")),
    el("p", { class: `callout ${plan.provenance?.authenticity === "verified" ? "ok" : "info"}` }, icon(plan.provenance?.authenticity === "verified" ? "badge-check" : "badge-help"), plan.provenance?.authenticity === "verified" ? `Authentic: signed by ${plan.provenance.signer?.name} (sequence ${plan.provenance.sequence}). Integrity ${plan.provenance.integrity}.` : `Not authentic: ${plan.provenance?.authenticity ?? "unknown"}. Integrity ${plan.provenance?.integrity ?? "?"} (an immutable commit or checksum, not a signer).`),
    el("p", { class: "muted small" }, icon("cpu"), ` Runtime: ${plan.runtime?.supervisor === "systemd" ? `systemd user units (restart ${plan.runtime.restart})` : "agent-managed processes"}. Rollback data safety: ${plan.rollback.dataSafety}.`),
    plan.distributed?.notes?.length ? el("ul", { class: "plain small" }, plan.distributed.notes.map((n) => el("li", { class: "callout info" }, icon("network"), n))) : null,
    plan.blockers.length ? el("div", { class: "callout bad" }, icon("ban"), el("div", {}, el("strong", {}, "Blocked"), el("ul", { class: "plain" }, plan.blockers.map((b) => el("li", {}, b))))) : null,
    BlueGreen({ strategy: plan.strategy.type, previousRelease: plan.currentRelease, releaseId: plan.candidateRelease, state: "REQUESTED", kind: "deploy" }),
    KeyValues([["Release", `${plan.currentRelease ?? "none"} → ${plan.candidateRelease}`], ["Source", plan.source.provider === "git" ? `${plan.source.refType} ${plan.source.ref} = commit ${plan.source.commit}` : `artifact sha256:${plan.source.sha256.slice(0, 16)}…`], ["Availability", plan.availability.summary], ["Resources", `memory ${plan.resources.requiredMemoryMb} MB needed / ${plan.resources.availableMemoryMb} MB free; disk ${plan.resources.requiredDiskMb} / ${plan.resources.availableDiskMb} MB`], ["Services", plan.services.map((s) => `${s.name} (${s.runtime}, ${s.instances} instance${s.instances > 1 ? "s" : ""}, grace ${s.shutdownGraceSeconds}s)`).join(", ")], ["Rollback", plan.rollback.eligible ? `eligible, to ${plan.rollback.to}` : "not eligible"], ["Permissions", `role ${plan.permissions.minimumRole} or higher${plan.permissions.privileged.length ? `; ${plan.permissions.privileged.join("; ")}` : ""}`], ["Approvals", `${plan.approvalsRequired} required`]]),
    plan.changes.configuration.length ? Panel({ title: "Changes", iconName: "git-commit-horizontal" }, el("ul", { class: "plain" }, plan.changes.configuration.map((c) => el("li", {}, Badge(c.kind), " ", c.action, " ", code(c.target))))) : null,
    Panel({ title: "Pipeline", iconName: "workflow", help: "Disabled or omitted stages are recorded in the audit log; none of them is read as a pass." }, Pipeline(plan.stages.map((s) => ({ id: s.id, type: s.type, enabled: s.enabled, status: s.enabled ? (s.requiresApproval ? "awaiting-approval" : "pending") : "skipped", reason: s.reason })))),
    plan.disabledChecks.length ? el("p", { class: "callout warn" }, icon("triangle-alert"), `Disabled or omitted: ${plan.disabledChecks.map((d) => d.stage).join(", ")}`) : null,
    el("details", {}, el("summary", {}, "Always enforced: no pipeline setting can turn these off"), el("ul", { class: "plain small" }, plan.mandatory.map((m) => el("li", {}, m)))),
    plan.warnings.length ? el("ul", { class: "plain small" }, plan.warnings.map((w) => el("li", { class: "callout warn" }, icon("triangle-alert"), w))) : null,
    conf.node, el("div", { class: "row wrap" }, approveBtn, deployBtn));
}

function planDialog(env, ctx) {
  const branch = el("input", { type: "text", placeholder: "default from the declaration", autocomplete: "off", "aria-label": "Branch" });
  const tag = el("input", { type: "text", placeholder: "or a tag", autocomplete: "off", "aria-label": "Tag" });
  const commit = el("input", { type: "text", placeholder: "or a full commit SHA", autocomplete: "off", "aria-label": "Commit" });
  const out = el("div", { class: "stack" });
  const go = Button({ label: "Preview plan", iconName: "file-search", variant: "primary", onclick: async (e) => {
    out.replaceChildren(Skeleton(4));
    try { const plan = await run(e.currentTarget, () => api.cloud.envPost(env, "plan", { branch: branch.value.trim(), tag: tag.value.trim(), commit: commit.value.trim() })); out.replaceChildren(PlanView(plan, env, ctx)); } catch (x) { out.replaceChildren(FailureHelp(x)); }
  } });
  openDrawer({ title: `Plan a deployment to ${env}`, subtitle: "The server inspects itself and pins the branch or tag to one commit. Nothing is changed by planning.", body: el("div", { class: "stack" }, el("div", { class: "row wrap" }, field("Branch", branch), field("Tag", tag), field("Commit", commit)), go, out) });
}

// ---------------------------------------------------------------- tabs
function RemoteOff(o) {
  return o.remoteEnabled ? null : el("p", { class: "callout info" }, icon("lock"), el("span", {}, "Remote management is off in this Studio session, so no server is contacted and no action is offered. Local declarations and connections are shown below. Start with ", code("pso studio --remote"), " to manage servers from here."));
}
const envSelect = (o, ctx, onchange, value) => {
  const names = o.environments.map((e) => e.name); const sel = el("select", { "aria-label": "Environment", onchange: () => onchange(sel.value) }, names.map((n) => { const x = el("option", { value: n }, n); if (n === value) x.selected = true; return x; }));
  return el("label", { class: "field" }, el("span", {}, "Environment"), sel);
};
const nav = (tab, env) => { location.hash = `#/cloud/${tab}${env ? `/${env}` : ""}`; };

async function liveStatus(env, host) {
  host.replaceChildren(Skeleton(3));
  try {
    // the policy compatibility view is optional (an older agent does not have it): its absence never hides the live status
    const [{ status: s, inspection: i }, compat] = await Promise.all([api.cloud.env(env, "status"), api.cloud.env(env, "policy-compat").catch(() => null)]);
    host.replaceChildren(el("div", { class: "stack" }, compatPanel(compat, env),
      el("div", { class: "row wrap" }, Badge(`active ${s.active?.release ?? "none"}`, s.active ? "ok" : "idle"), Badge(`previous ${s.previous ?? "none"}`), Badge(`lock ${s.lock.status}`, s.lock.status === "free" ? "ok" : "warn"), s.deployment ? StatePill(s.deployment.effectiveState) : null, el("span", { class: "muted small" }, `read ${fmtTime(new Date().toISOString())}`)),
      s.services.length ? DataTable({ caption: "Services", columns: [{ key: "service", label: "Service" }, { key: "instance", label: "#" }, { key: "running", label: "State", render: (r) => (r.running ? Badge("running", "ok") : Badge("not running", "bad")) }, { key: "port", label: "Port", mono: true }, { key: "pid", label: "PID", mono: true }], rows: s.services, pageSize: 10 }) : el("p", { class: "muted" }, "No active release on this server."),
      el("div", { class: "metrics" }, MetricCard({ label: "Memory free", value: `${i.memory.availableMb} MB`, hint: `of ${i.memory.totalMb} MB`, iconName: "memory-stick" }), MetricCard({ label: "Disk free", value: `${i.disk.freeMb} MB`, iconName: "hard-drive" }), MetricCard({ label: "CPUs", value: String(i.cpu.count), iconName: "cpu" }))));
  } catch (e) { host.replaceChildren(FailureHelp(e)); }
}

function overviewTab(o, ctx) {
  const enrolled = o.connections.filter((c) => c.enrolled).length;
  return el("div", { class: "stack" }, RemoteOff(o),
    el("div", { class: "metrics" }, MetricCard({ label: "Environments", value: String(o.environments.length), iconName: "layers" }), MetricCard({ label: "Connections", value: String(o.connections.length), hint: `${enrolled} enrolled`, iconName: "plug" }),
      MetricCard({ label: "Credential store", value: o.credentialStore.available ? o.credentialStore.id : "not available", tone: o.credentialStore.available ? "ok" : "bad", hint: o.credentialStore.available ? "secrets never leave it" : o.credentialStore.reason, iconName: "key-round" }), MetricCard({ label: "Local audit", value: o.localAudit.ok ? "intact" : "BROKEN", tone: o.localAudit.ok ? "ok" : "bad", hint: `${o.localAudit.entries} entries`, iconName: "scroll-text" })),
    o.environments.length ? o.environments.map((e) => { const host = el("div", {}, el("p", { class: "muted" }, "Live status is read from the server when you ask for it; it is not shown from memory."));
      return Panel({ title: e.name, iconName: "server", actions: o.remoteEnabled ? [Button({ label: "Read live status", iconName: "refresh-cw", variant: "ghost", onclick: (ev) => run(ev.currentTarget, () => liveStatus(e.name, host)) }), Button({ label: "Plan deployment", iconName: "rocket", onclick: () => planDialog(e.name, ctx) })] : null },
        el("div", { class: "row wrap" }, EnvPill(e.environment), Badge(e.strategy ?? "?"), Badge(`connection ${e.connection} (${e.connectionState})`, e.connectionState === "enrolled" ? "ok" : "warn"), e.problems.length ? Badge(`${e.problems.length} problem(s)`, "bad") : null), host); })
      : EmptyState({ title: "No environments declared", text: "Create one with the CLI; it writes deploy/<environment>.deployment.pso.ts.", action: CommandHint("pso environment:add production --connection prod --repo <git-url>") }));
}

function environmentsTab(o, ctx) {
  return el("div", { class: "stack" }, RemoteOff(o), o.environments.length ? DataTable({ caption: "Declared environments", rows: o.environments, pageSize: 15, onRowClick: (r) => envDrawer(r, o, ctx), rowLabel: () => "open declaration", columns: [
    { key: "environment", label: "Environment", render: (r) => EnvPill(r.environment) }, { key: "name", label: "Application" }, { key: "strategy", label: "Strategy", render: (r) => Badge(`${r.strategy ?? "?"}${r.proxy === "nginx" ? " + nginx" : ""}`) },
    { key: "source", label: "Source", sortable: false, render: (r) => (r.source ? (r.source.provider === "git" ? `${r.source.url} @ ${r.source.ref}` : r.source.path) : "-"), mono: true },
    { key: "connectionState", label: "Connection", render: (r) => Badge(`${r.connection}: ${r.connectionState}`, r.connectionState === "enrolled" ? "ok" : "warn") },
    { key: "problems", label: "Declaration", render: (r) => (r.problems.length ? Badge(`${r.problems.length} error(s)`, "bad") : r.warnings.length ? Badge(`${r.warnings.length} warning(s)`, "warn") : Badge("valid", "ok")) }] })
    : EmptyState({ title: "No deployment declarations", action: CommandHint("pso environment:add") }));
}
async function envDrawer(r, o, ctx) {
  const body = el("div", { class: "stack" }, Skeleton(3));
  openDrawer({ title: r.name, subtitle: `${r.environment} · ${r.file}`, body, actions: o.remoteEnabled ? Button({ label: "Plan deployment", iconName: "rocket", variant: "primary", onclick: () => planDialog(r.name, ctx) }) : null });
  try {
    const d = o.remoteEnabled ? await api.cloud.env(r.name, "declaration") : null;
    const diags = [...r.problems, ...r.warnings];
    body.replaceChildren(diags.length ? el("ul", { class: "plain" }, diags.map((x) => el("li", { class: `callout ${x.level === "error" ? "bad" : "warn"}` }, icon(x.level === "error" ? "circle-x" : "triangle-alert"), el("span", {}, code(x.path), " ", x.message)))) : el("p", { class: "callout ok" }, icon("circle-check"), "The declaration is valid (checked statically: no project code was executed)."),
      d ? Panel({ title: "Declaration", iconName: "file-code" }, el("pre", { class: "logbox", tabindex: "0" }, JSON.stringify(d.deployment, null, 2))) : el("p", { class: "muted" }, "The full declaration is shown when remote management is enabled; it is also in the file above."));
  } catch (e) { body.replaceChildren(FailureHelp(e)); }
}

function connectionForm(o, ctx) {
  const f = { name: el("input", { type: "text", placeholder: "production", "aria-label": "Connection name", autocomplete: "off" }), host: el("input", { type: "text", placeholder: "203.0.113.10", "aria-label": "Host", autocomplete: "off" }), port: el("input", { type: "number", value: "22", "aria-label": "Port" }), user: el("input", { type: "text", placeholder: "deploy", "aria-label": "User", autocomplete: "off" }), keyPath: el("input", { type: "text", placeholder: "~/.ssh/id_ed25519 (stays where it is)", "aria-label": "Private key file", autocomplete: "off" }), secret: el("input", { type: "password", autocomplete: "new-password", "aria-label": "Secret" }) };
  const auth = el("select", { "aria-label": "Authentication" }, [["agent", "ssh-agent"], ["key", "Private key file"], ["password", "Password (explicit alternative)"]].map(([v, t]) => el("option", { value: v }, t)));
  const keys = el("div", { class: "stack" }); let chosen;
  const fetchKeys = Button({ label: "Fetch host keys", iconName: "fingerprint", onclick: async (e) => {
    const r = await run(e.currentTarget, () => api.cloud.hostKeys(f.host.value.trim(), Number(f.port.value) || 22)); chosen = undefined;
    keys.replaceChildren(el("p", { class: "callout warn" }, icon("fingerprint"), "Compare one of these with the fingerprint your provider shows (or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server) before approving it. A changed key is refused later."),
      ...r.keys.map((k) => el("label", { class: "row" }, el("input", { type: "radio", name: "hostkey", onchange: () => { chosen = k.fingerprint; } }), Badge(k.type), el("code", { class: "mono small" }, k.fingerprint))));
  } });
  const add = Button({ label: "Approve host key and add", iconName: "plus", variant: "primary", onclick: async (e) => {
    if (!chosen) { toast("Approve one host key first", "bad"); return; }
    await run(e.currentTarget, () => api.cloud.post("connections", { name: f.name.value.trim(), host: f.host.value.trim(), port: Number(f.port.value) || 22, user: f.user.value.trim(), auth: auth.value, acceptHostKey: chosen, keyPath: auth.value === "key" ? f.keyPath.value.trim() : "", ...(auth.value === "password" ? { password: f.secret.value } : auth.value === "key" && f.secret.value ? { passphrase: f.secret.value } : {}) }));
    f.secret.value = ""; toast("Connection added; the secret is in the protected credential store"); closeDrawer(false); ctx.rerender();
  } });
  openDrawer({ title: "Add a connection", subtitle: "SSH to a Linux server. Host identity is verified strictly.", body: el("div", { class: "stack" },
    field("Name", f.name), el("div", { class: "row wrap" }, field("Host", f.host), field("Port", f.port), field("User", f.user)), field("Authentication", auth),
    field("Private key file", f.keyPath, "Only the path is stored; the key is never copied."), field("Passphrase or password", f.secret, "Sent once to the local Studio process and stored in the protected credential store. It is never shown again."),
    fetchKeys, keys, add) });
}

function installForm(c, o, ctx) {
  const mode = el("select", { "aria-label": "Management mode" }, [["development", "Development"], ["protected", "Protected production management"]].map(([v, t]) => el("option", { value: v }, t)));
  const env = el("input", { type: "text", value: "", placeholder: "production", "aria-label": "Environment name", autocomplete: "off" });
  const go = Button({ label: "Install and enroll", iconName: "download", variant: "primary", onclick: async (e) => {
    const r = await run(e.currentTarget, () => api.cloud.post("agent/install", { name: c.name, mode: mode.value, environment: env.value.trim() }));
    toast(`Agent ${r.version} installed; this machine is ${r.role}`); closeDrawer(false); ctx.rerender();
  } });
  openDrawer({ title: `Install the agent on ${c.name}`, subtitle: "Uploads a verified single file over SSH, provisions it and enrolls this machine. Remote management stays disabled unless you choose a mode.", body: el("div", { class: "stack" }, field("Mode", mode, "Protected requires approvals as configured by the server policy."), field("Environment name", env, "The server will only accept declarations for this environment."), go) });
}

/** Diagnoses the access rights of the private key file of a connection; repairs them only after the person types the connection name. */
async function keyDrawer(c) {
  const k = await api.cloud.post("connections/key", { name: c.name });
  const confirm = el("input", { type: "text", "aria-label": `Type ${c.name} to confirm`, placeholder: c.name, autocomplete: "off" });
  const result = el("div", {});
  const repair = k.verdict === "too-open" ? el("div", { class: "stack" },
    el("div", { class: "callout warn" }, icon("triangle-alert"), el("span", {}, "OpenSSH refuses this key while other users can read the file. A repair runs exactly the commands below on this one file and nothing else:")),
    el("pre", {}, k.plan.join("\n")), el("label", {}, `Type ${c.name} to confirm`, confirm),
    Button({ label: "Restrict the key to my account", iconName: "lock", variant: "primary", onclick: (e) => run(e.currentTarget, async () => {
      const r = await api.cloud.post("connections/key-repair", { name: c.name, confirm: confirm.value });
      result.replaceChildren(el("div", { class: `callout ${r.after.verdict === "ok" ? "ok" : "bad"}` }, icon(r.after.verdict === "ok" ? "circle-check" : "circle-x"), el("span", {}, `${r.after.verdict === "ok" ? "Repaired" : "Not repaired"}: ${r.after.detail}`)), el("pre", {}, r.ran.join("\n")));
    }) })) : null;
  openDrawer({ title: `Private key: ${c.name}`, body: el("div", { class: "stack" },
    el("div", { class: `callout ${k.verdict === "ok" ? "ok" : "warn"}` }, icon(k.verdict === "ok" ? "circle-check" : "triangle-alert"), el("span", {}, el("strong", {}, k.verdict.toUpperCase()), " ", k.detail)), el("p", { class: "mono" }, k.path),
    DataTable({ caption: "Who can access the file", rows: k.entries, columns: [{ key: "principal", label: "Principal" }, { key: "rights", label: "Rights", mono: true }, { key: "safe", label: "", render: (e) => Badge(e.safe ? "ok" : "open", e.safe ? "ok" : "bad") }] }), repair, result) });
}

function connectionsTab(o, ctx) {
  const act = (label, ic, fn, variant = "ghost") => Button({ label, iconName: ic, variant, onclick: (e) => run(e.currentTarget, fn) });
  return el("div", { class: "stack" }, RemoteOff(o), o.remoteEnabled ? el("div", { class: "row" }, Button({ label: "Add connection", iconName: "plus", variant: "primary", onclick: () => connectionForm(o, ctx) })) : null,
    o.connections.length ? DataTable({ caption: "Connections", rows: o.connections, pageSize: 15, columns: [
      { key: "name", label: "Name" }, { key: "host", label: "Server", render: (c) => `${c.user}@${c.host}:${c.port}`, mono: true }, { key: "auth", label: "SSH auth", render: (c) => Badge(c.auth + (c.hasPassphrase ? " + passphrase" : "")) },
      { key: "hostKeyFingerprint", label: "Host key", sortable: false, render: (c) => (c.hostKeyFingerprint ? Badge("pinned", "ok", c.hostKeyFingerprint) : Badge("not pinned", "bad")) },
      { key: "agentFingerprint", label: "Agent", sortable: false, render: (c) => (c.agentFingerprint ? Badge("pinned", "ok", c.agentFingerprint) : Badge("not installed", "idle")) },
      { key: "enrolled", label: "Session", render: (c) => (c.revoked ? Badge("revoked", "bad") : c.enrolled ? Badge(`enrolled · ${c.role}`, "ok") : Badge("not enrolled", "warn")) },
      { key: "actions", label: "", sortable: false, render: (c) => (o.remoteEnabled ? el("div", { class: "row wrap" },
        act("Test", "plug", async () => { const r = await api.cloud.post("connections/test", { name: c.name }); openDrawer({ title: `Connection test: ${c.name}`, body: el("ul", { class: "plain" }, r.steps.map((s) => el("li", { class: `callout ${s.ok ? "ok" : "bad"}` }, icon(s.ok ? "circle-check" : "circle-x"), el("span", {}, el("strong", {}, s.step), " ", s.detail)))) }); }),
        c.auth === "key" ? act("Private key", "key", async () => keyDrawer(c)) : null,
        !c.agentFingerprint || !c.enrolled ? act("Install agent", "download", async () => installForm(c, o, ctx)) : null) : null) }] })
      : EmptyState({ title: "No connections yet", text: o.remoteEnabled ? "Add one to manage a server." : "Add one with the CLI.", action: CommandHint("pso connection:add prod --host <host> --user <user>") }));
}

async function deploymentsTab(o, ctx) {
  const env = ctx.params[1] ?? o.environments[0]?.name;
  if (!o.remoteEnabled) return el("div", { class: "stack" }, RemoteOff(o), EmptyState({ title: "Deployment history is read from the servers", text: "It is not stored here. Enable remote management to read it.", iconName: "history" }));
  if (!env) return EmptyState({ title: "No environments declared", action: CommandHint("pso environment:add") });
  const host = el("div", {}, Skeleton(4));
  (async () => {
    try {
      const h = await api.cloud.env(env, "history");
      host.replaceChildren(el("div", { class: "stack" },
        h.releases.length ? el("p", { class: "muted small" }, `Releases kept on the server: ${h.releases.map((r) => `${r.id}${r.active ? " (active)" : r.previous ? " (previous)" : ""}`).join(", ")}`) : null,
        DataTable({ caption: "Deployments", rows: h.history, pageSize: 15, onRowClick: (r) => openDeployment(env, r.id, ctx), rowLabel: () => "open deployment", empty: EmptyState({ title: "No deployments yet", iconName: "history" }), columns: [
          { key: "id", label: "Deployment", mono: true }, { key: "kind", label: "Kind" }, { key: "effectiveState", label: "State", render: (r) => StatePill(r.effectiveState) }, { key: "releaseId", label: "Release", mono: true }, { key: "strategy", label: "Strategy" },
          { key: "startedAt", label: "Started", render: (r) => fmtTime(r.startedAt) }, { key: "duration", label: "Duration", sortable: false, render: (r) => (r.finishedAt ? `${Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))} s` : "running") },
          { key: "requestedBy", label: "By", render: (r) => r.requestedBy?.name ?? "?" }] })));
    } catch (e) { host.replaceChildren(ErrorState({ text: e.message, onRetry: () => ctx.rerender() })); }
  })();
  const conf = confirmBox(env);
  return el("div", { class: "stack" }, el("div", { class: "row wrap" }, envSelect(o, ctx, (v) => nav("deployments", v), env), EnvPill(env), Button({ label: "Plan deployment", iconName: "rocket", variant: "primary", onclick: () => planDialog(env, ctx) }),
    Button({ label: "Roll back to previous", iconName: "undo-2", onclick: (e) => { const dlg = openDrawer({ title: `Roll back ${env}`, subtitle: "Re-activates the previous release with the same verify-switch-drain sequence. Database changes are not reverted.", body: el("div", { class: "stack" }, conf.node, Button({ label: "Roll back", iconName: "undo-2", variant: "danger", onclick: async (b) => { const d = await run(b.currentTarget, () => api.cloud.envPost(env, "rollback", { confirm: conf.value() })); closeDrawer(false); openDeployment(env, d.id, ctx); } })) }); void dlg; void e; } })), host);
}

function pipelinesTab(o) {
  return el("div", { class: "stack" }, o.pipelines.length ? o.pipelines.map((p) => Panel({ title: p.name, iconName: "workflow", help: p.file }, Pipeline(p.stages.map((s) => ({ id: s.id ?? s.type, type: s.type, enabled: s.enabled !== false, status: s.enabled === false ? "skipped" : "pending", reason: s.enabled === false ? "disabled" : s.type === "custom" ? "custom stage: runs only if the server policy allows it" : undefined }))), p.problems.length ? el("ul", { class: "plain" }, p.problems.map((x) => el("li", { class: "callout bad" }, icon("circle-x"), x.message))) : null))
    : EmptyState({ title: "No pipeline declarations", text: "Without one, the default pipeline runs every standard stage except project tests.", action: CommandHint("pso pipeline:validate") }),
    el("p", { class: "callout info" }, icon("shield-check"), "Optional stages can be turned off. Identity, authorization, locking, release integrity, a valid proxy configuration and candidate readiness are enforced by the server's engine and are not stages: no pipeline setting disables them."));
}

async function infrastructureTab(o, ctx) {
  const env = ctx.params[1] ?? o.environments[0]?.name;
  if (!o.remoteEnabled) return el("div", { class: "stack" }, RemoteOff(o), EmptyState({ title: "Infrastructure is read from the servers", iconName: "server-cog" }));
  if (!env) return EmptyState({ title: "No environments declared" });
  const [i, p] = await Promise.all([api.cloud.env(env, "inspect"), api.cloud.env(env, "provision-plan")]);
  const conf = confirmBox(env);
  const meter = (label, free, total, unit) => { const used = total ? Math.round(100 * (1 - free / total)) : 0; const bar = el("div", { class: `meter ${used > 90 ? "bad" : used > 75 ? "warn" : "ok"}`, role: "img", "aria-label": `${label}: ${used}% used` }, el("span", {})); setVar(bar.firstChild, "--w", `${used}%`); return el("div", {}, el("div", { class: "row between" }, el("span", {}, label), el("span", { class: "muted small" }, `${free} ${unit} free of ${total}`)), bar); };
  return el("div", { class: "stack" }, el("div", { class: "row wrap" }, envSelect(o, ctx, (v) => nav("infrastructure", v), env), EnvPill(env)),
    i.blockers.length ? el("div", { class: "callout bad" }, icon("ban"), el("div", {}, el("strong", {}, "Blockers"), el("ul", { class: "plain" }, i.blockers.map((b) => el("li", {}, b))))) : el("p", { class: "callout ok" }, icon("circle-check"), "No blockers: this server is ready for deployments."),
    el("div", { class: "cols" }, Panel({ title: "Server", iconName: "server" }, KeyValues([["System", `${i.os.distro ?? i.os.platform} ${i.os.arch}`], ["Agent runs as", `${i.user.name}${i.user.root ? " (ROOT: not recommended)" : " (unprivileged)"}`], ["CPUs", String(i.cpu.count)], ["Agent", `${i.agent.version}, mode ${i.agent.mode}`]]), meter("Memory", i.memory.availableMb, i.memory.totalMb, "MB"), meter("Disk", i.disk.freeMb, i.disk.totalMb || i.disk.freeMb, "MB")),
      Panel({ title: "Tools", iconName: "wrench" }, DataTable({ caption: "Tools", pageSize: 10, rows: Object.entries(i.tools).map(([k, v]) => ({ tool: k, ...v })), columns: [{ key: "tool", label: "Tool" }, { key: "available", label: "Available", render: (r) => (r.available ? Badge("yes", "ok") : Badge("no", "idle")) }, { key: "version", label: "Version", mono: true }] }))),
    Panel({ title: "nginx virtual hosts", iconName: "network", help: "Files marked PSO are managed by PSO. Everything else is external and is never modified." }, i.nginx.vhosts.length ? DataTable({ caption: "nginx", pageSize: 10, rows: i.nginx.vhosts, columns: [{ key: "file", label: "File", mono: true }, { key: "managed", label: "Owner", render: (r) => (r.managed ? Badge(`PSO · ${r.app}`, "ok") : Badge("external", "idle")) }, { key: "serverNames", label: "server_name", render: (r) => r.serverNames.join(" ") || "-", sortable: false }, { key: "listens", label: "listen", render: (r) => r.listens.join(", "), sortable: false }] }) : el("p", { class: "muted" }, "No virtual hosts found.")),
    Panel({ title: "Provisioning plan", iconName: "clipboard-list", help: p.note, actions: Button({ label: "Apply unprivileged steps", iconName: "play", onclick: async (e) => { const r = await run(e.currentTarget, () => api.cloud.envPost(env, "provision-apply", { confirm: conf.value() })); toast(r.applied.length ? r.applied.join("; ") : "Already converged"); ctx.rerender(); } }) },
      DataTable({ caption: "Provisioning steps", pageSize: 12, rows: p.steps, columns: [{ key: "status", label: "Who", render: (r) => Badge({ ok: "done", agent: "PSO (unprivileged)", admin: "administrator", info: "note" }[r.status], r.status === "ok" ? "ok" : r.status === "admin" ? "warn" : "neutral") }, { key: "title", label: "Step" }, { key: "detail", label: "Detail", sortable: false }] }),
      conf.node, el("details", {}, el("summary", {}, "Administrator script (review it; PSO never runs it)"), CopyButton(() => p.adminScript), el("pre", { class: "logbox", tabindex: "0" }, p.adminScript))));
}

async function credentialsTab(o, ctx) {
  const env = ctx.params[1] ?? o.environments[0]?.name;
  const act = (label, ic, fn, variant = "ghost") => Button({ label, iconName: ic, variant, onclick: (e) => run(e.currentTarget, fn) });
  const local = o.connections.length ? DataTable({ caption: "Local credentials", rows: o.connections, pageSize: 15, columns: [
    { key: "name", label: "Connection" }, { key: "auth", label: "SSH", render: (c) => `${c.auth}${c.hasPassword ? " (password in store)" : c.hasPassphrase ? " (passphrase in store)" : ""}` },
    { key: "keyPath", label: "Key file", mono: true, render: (c) => c.keyPath ?? "-" }, { key: "clientId", label: "Agent identity", mono: true, render: (c) => (c.clientId ? c.clientId.slice(0, 22) + "…" : "-") },
    { key: "credentialVersion", label: "Version" }, { key: "actions", label: "", sortable: false, render: (c) => (o.remoteEnabled ? el("div", { class: "row wrap" },
      c.enrolled ? act("Rotate client key", "rotate-ccw", async () => { const r = await api.cloud.post("connections/rotate", { name: c.name, kind: "client-key" }); toast(`Rotated: ${r.clientId.slice(0, 18)}…`); ctx.rerender(); }) : null,
      act("Revoke", "unlink", async () => { const x = confirmBox(c.name); openDrawer({ title: `Revoke ${c.name}`, subtitle: "Ends this machine's access on the server and deletes every local secret of the connection.", body: el("div", { class: "stack" }, x.node, Button({ label: "Revoke", iconName: "unlink", variant: "danger", onclick: async (b) => { if (x.value() !== c.name) { toast("Type the connection name to confirm", "bad"); return; } const r = await run(b.currentTarget, () => api.cloud.post("connections/revoke", { name: c.name })); toast(r.serverRevoked ? "Revoked on the server and locally" : "Removed locally; the server could not be reached"); closeDrawer(false); ctx.rerender(); } })) }); })) : null) }] })
    : EmptyState({ title: "No credentials", iconName: "key-round" });
  let remote = null;
  if (o.remoteEnabled && env) {
    const host = el("div", {}, Skeleton(3));
    Promise.all([api.cloud.env(env, "clients"), api.cloud.env(env, "secrets")]).then(([clients, secrets]) => {
      const conf = confirmBox(env); const role = el("select", { "aria-label": "Role" }, ["viewer", "operator", "deployer", "admin"].map((r) => el("option", { value: r }, r)));
      const name = el("input", { type: "text", placeholder: "secret name", "aria-label": "Secret name", autocomplete: "off" }); const value = el("input", { type: "password", placeholder: "value", "aria-label": "Secret value", autocomplete: "new-password" });
      host.replaceChildren(el("div", { class: "stack" },
        DataTable({ caption: "Who may manage this environment", rows: clients, pageSize: 10, columns: [{ key: "name", label: "Client" }, { key: "role", label: "Role", render: (c) => Badge(c.role) }, { key: "revoked", label: "State", render: (c) => (c.revoked ? Badge("revoked", "bad") : Badge("active", "ok")) }, { key: "lastSeen", label: "Last seen", render: (c) => fmtTime(c.lastSeen) },
          { key: "x", label: "", sortable: false, render: (c) => (c.revoked ? null : act("Revoke access", "unlink", async () => { await api.cloud.envPost(env, "revoke-client", { clientId: c.id, confirm: conf.value() }); toast("Access revoked; its sessions ended"); ctx.rerender(); })) }] }),
        conf.node, el("div", { class: "row wrap" }, field("Role of the invitation", role), act("Create single-use enrollment token", "ticket", async () => { const t = await api.cloud.envPost(env, "invite", { role: role.value, minutes: 15, confirm: conf.value() }); openDrawer({ title: "Enrollment token", subtitle: `Single use, role ${t.role}, expires ${fmtTime(t.expiresAt)}. Shown once.`, body: el("div", { class: "stack" }, el("pre", { class: "logbox", tabindex: "0" }, t.token), CopyButton(() => t.token), el("p", { class: "muted" }, "Give it to the teammate over a private channel. They run ", code("pso agent:enroll <connection>"), ".")) }); }, "primary")),
        Panel({ title: "Server secrets", iconName: "lock", help: "Names only. Values are stored on the server (mode 600) and injected into services as environment variables; they are never shown." },
          secrets.names.length ? el("ul", { class: "plain" }, secrets.names.map((n) => el("li", { class: "row" }, code(n), act("Remove", "trash-2", async () => { await api.cloud.envPost(env, "secret", { name: n, remove: true, confirm: conf.value() }); toast("Secret removed"); ctx.rerender(); })))) : el("p", { class: "muted" }, "No secrets stored."),
          el("div", { class: "row wrap" }, name, value, act("Store secret", "plus", async () => { await api.cloud.envPost(env, "secret", { name: name.value.trim(), value: value.value, confirm: conf.value() }); value.value = ""; toast("Stored on the server; it is not shown again"); ctx.rerender(); }, "primary")))));
    }).catch((e) => host.replaceChildren(FailureHelp(e)));
    remote = Panel({ title: `Access and secrets: ${env}`, iconName: "users", actions: envSelect(o, ctx, (v) => nav("credentials", v), env) }, host);
  }
  return el("div", { class: "stack" }, RemoteOff(o), el("p", { class: "callout info" }, icon("shield-check"), `Secrets are kept in ${o.credentialStore.available ? o.credentialStore.id : "no available store"} and are never sent to this page. A native store protects against other users and stolen disks, not against malware running as you.`), Panel({ title: "Connections' credentials", iconName: "key-round" }, local), remote);
}

async function auditTab(o, ctx) {
  const l = await api.cloud.localAudit().catch(() => null);
  const env = ctx.params[1] ?? o.environments[0]?.name; let remote = null;
  if (o.remoteEnabled && env) {
    const host = el("div", {}, Skeleton(3));
    api.cloud.env(env, "audit").then((a) => host.replaceChildren(DataTable({ caption: "Server audit", rows: [...a.entries].reverse(), pageSize: 20, columns: [{ key: "ts", label: "Time", render: (r) => new Date(r.ts).toLocaleString() }, { key: "outcome", label: "Outcome", render: (r) => Badge(r.outcome, r.outcome === "ok" ? "ok" : r.outcome === "info" ? "neutral" : "bad") }, { key: "event", label: "Event", mono: true }, { key: "actor", label: "Actor", render: (r) => r.actor?.name ?? "-" }, { key: "dep", label: "Deployment", mono: true, render: (r) => r.ids?.deployment ?? "-" }] }))).catch((e) => host.replaceChildren(FailureHelp(e)));
    remote = Panel({ title: `Server audit: ${env}`, iconName: "scroll-text", help: "Hash-chained and sanitized. This detects edits and accidents; it does not stop a fully privileged server administrator from rewriting the whole chain.", actions: [envSelect(o, ctx, (v) => nav("audit", v), env), Button({ label: "Verify chain", iconName: "badge-check", onclick: async (e) => { const v = await run(e.currentTarget, () => api.cloud.env(env, "audit", { verify: 1 })); toast(v.ok ? `Intact: ${v.entries} entries` : `BROKEN at entry ${v.brokenAt}`, v.ok ? "ok" : "bad"); } })] }, host);
  }
  return el("div", { class: "stack" }, RemoteOff(o), remote, Panel({ title: "Local actions on this machine", iconName: "history", help: `Chain ${l?.chain?.ok ? "intact" : "NOT verified"}${l?.chain ? ` (${l.chain.entries} entries)` : ""}. Secrets are never written here.` },
    l?.entries?.length ? DataTable({ caption: "Local audit", rows: l.entries, pageSize: 20, columns: [{ key: "ts", label: "Time", render: (r) => new Date(r.ts).toLocaleString() }, { key: "event", label: "Event", mono: true }, { key: "data", label: "Details", sortable: false, render: (r) => JSON.stringify(r.data ?? {}).slice(0, 140) }] }) : (o.remoteEnabled ? EmptyState({ title: "Nothing recorded yet", iconName: "history" }) : el("p", { class: "muted" }, "The local audit is read when remote management is enabled."))));
}

async function signingTab(o, ctx) {
  const env = ctx.params[1] ?? o.environments[0]?.name; const act = (label, ic, fn, variant = "ghost") => Button({ label, iconName: ic, variant, onclick: (e) => run(e.currentTarget, fn) });
  const name = el("input", { type: "text", placeholder: "signer name (e.g. release-bot)", "aria-label": "Signer name", autocomplete: "off" });
  const local = Panel({ title: "Signing identities on this machine", iconName: "key-round", help: "The private key is created here and stored in the protected credential store. It is never shown, exported, put in a project or sent to a server." },
    o.signers.length ? DataTable({ caption: "Signers", rows: o.signers, pageSize: 10, columns: [{ key: "name", label: "Signer" }, { key: "keyId", label: "Key id", mono: true }, { key: "createdAt", label: "Created", render: (s) => fmtTime(s.createdAt) }, { key: "x", label: "", sortable: false, render: (s) => (o.remoteEnabled ? act("Remove key", "trash-2", async () => { await api.cloud.post("signers", { name: s.name, remove: true }); toast("Removed from this machine. Servers that trust it still do until you revoke it there."); ctx.rerender(); }) : null) }] }) : EmptyState({ title: "No signers yet", iconName: "key-round" }),
    o.remoteEnabled ? el("div", { class: "row wrap" }, name, act("Generate signer", "plus", async () => { const s = await api.cloud.post("signers", { name: name.value.trim() }); toast(`Created ${s.name}`); ctx.rerender(); })) : null);
  let remote = null;
  if (o.remoteEnabled && env) {
    const host = el("div", {}, Skeleton(3));
    Promise.all([api.cloud.env(env, "trust"), api.cloud.env(env, "policy"), api.cloud.env(env, "policy-compat").catch(() => null)]).then(([trust, policy, compat]) => {
      const conf = confirmBox(env); const signer = el("select", { "aria-label": "Signer" }, o.signers.map((s) => el("option", { value: s.name }, s.name)));
      const apps = el("input", { type: "text", placeholder: "applications (optional, comma separated)", "aria-label": "Applications", autocomplete: "off" }); const until = el("input", { type: "date", "aria-label": "Valid until" });
      const seq = el("input", { type: "number", min: "1", placeholder: "sequence", "aria-label": "Sequence" }); const path = el("input", { type: "text", placeholder: "checkout inside the workspace (default: the workspace)", "aria-label": "Checkout path", autocomplete: "off" });
      const file = el("input", { type: "text", placeholder: "signed manifest file (e.g. app.release.signed.json)", "aria-label": "Signed manifest file", autocomplete: "off" }); const result = el("div", {});
      host.replaceChildren(el("div", { class: "stack" },
        el("p", { class: `callout ${policy.requireSignedReleases ? "ok" : "info"}` }, icon(policy.requireSignedReleases ? "shield-check" : "shield"), policy.requireSignedReleases ? "This environment REQUIRES signed releases. No project file can change that." : "Signed releases are optional on this environment.",
          act(policy.requireSignedReleases ? "Stop requiring" : "Require signed releases", "shield-check", async () => { await api.cloud.envPost(env, "policy-set", { changes: { requireSignedReleases: !policy.requireSignedReleases }, confirm: conf.value() }); toast("Policy updated"); ctx.rerender(); })),
        DataTable({ caption: "Trusted signers of this environment", rows: trust, pageSize: 10, columns: [{ key: "name", label: "Signer" }, { key: "keyId", label: "Key id", mono: true }, { key: "state", label: "State", render: (s) => (s.revokedAt ? Badge("revoked", "bad") : Badge("trusted", "ok")) }, { key: "apps", label: "Applications", render: (s) => (s.apps ? s.apps.join(", ") : "all") }, { key: "notAfter", label: "Until", render: (s) => (s.notAfter ? fmtTime(s.notAfter) : "-") },
          { key: "x", label: "", sortable: false, render: (s) => (s.revokedAt ? null : act("Revoke", "ban", async () => { await api.cloud.envPost(env, "trust-revoke", { keyId: s.keyId, reason: "revoked from Studio", confirm: conf.value() }); toast("Revoked. It takes effect at once."); ctx.rerender(); })) }] }),
        conf.node,
        Panel({ title: "Trust a signer here", iconName: "badge-plus", help: "Superadministrator only. Adds the PUBLIC key of a local signer to this environment's trust store." }, el("div", { class: "row wrap" }, field("Signer", signer), apps, until, act("Trust signer", "badge-check", async () => { await api.cloud.envPost(env, "trust-add", { signer: signer.value, apps: apps.value, notAfter: until.value, confirm: conf.value() }); toast("Signer is now trusted here"); ctx.rerender(); }))),
        Panel({ title: "Sign and verify a release", iconName: "file-signature", help: "Signs the immutable commit of a CLEAN checkout with a strictly increasing sequence; the server verifies it against its own trust store at planning and again at start." },
          el("div", { class: "row wrap" }, field("Signer", signer.cloneNode(true)), seq, path, act("Sign", "pen-line", async () => { const sel = host.querySelectorAll("select")[host.querySelectorAll("select").length - 1]; const r = await api.cloud.envPost(env, "sign", { signer: sel.value, sequence: Number(seq.value), path: path.value.trim(), confirm: conf.value() }); file.value = r.file; toast(`Signed: ${r.file}`); })),
          el("div", { class: "row wrap" }, file, act("Verify on the server", "search-check", async () => { const r = await api.cloud.envPost(env, "verify", { signedFile: file.value.trim(), confirm: conf.value() }); result.replaceChildren(el("p", { class: `callout ${r.authenticity === "verified" ? "ok" : "bad"}` }, icon(r.authenticity === "verified" ? "badge-check" : "badge-x"), `Authenticity: ${r.authenticity}. Integrity: ${r.integrity}. ${r.reasons.join(" ")}`)); })), result)));
    }).catch((e) => host.replaceChildren(FailureHelp(e)));
    remote = Panel({ title: `Trusted signers and releases: ${env}`, iconName: "badge-check", actions: envSelect(o, ctx, (v) => nav("signing", v), env) }, host);
  }
  return el("div", { class: "stack" }, RemoteOff(o), el("p", { class: "callout info" }, icon("info"), "Integrity says the bytes are the ones named; authenticity says a signer this environment trusts named them. Both are reported, never merged."), local, remote);
}

// ---------------------------------------------------------------- entry
export async function cloudView(ctx) {
  const tab = TABS.some((t) => t[0] === ctx.params[0]) ? ctx.params[0] : "overview";
  const o = await api.cloud.overview(); for (const e of o.environments) ENV_OF[e.name] = e.environment;
  const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Cloud sections" }, TABS.map(([id, ic, label]) => el("a", { class: "tab", role: "tab", href: `#/cloud/${id}${ctx.params[1] && id === tab ? `/${ctx.params[1]}` : ""}`, "aria-selected": String(id === tab) }, icon(ic), label)));
  const content = { overview: overviewTab, environments: environmentsTab, connections: connectionsTab, deployments: deploymentsTab, pipelines: pipelinesTab, infrastructure: infrastructureTab, credentials: credentialsTab, signing: signingTab, audit: auditTab, applications: applicationsTab, endpoints: endpointsTab, services: servicesTab, nginx: nginxTab, network: networkTab }[tab];
  let body;
  try { body = await content(o, ctx); } catch (e) { body = ErrorState({ text: e.message, onRetry: () => ctx.rerender() }); }
  return Page({ title: "Cloud", question: "Where is this project deployed, what is running there, and who may change it?", docs: { path: "cloud/index.html", text: "Cloud docs" } }, tabs, body);
}

// What this agent can do that the server's policy does not permit yet (read-only: applying a migration is an administrator's CLI step, audited and reversible).
function compatPanel(c, env) {
  if (!c) return null;
  const pending = c.migrations.filter((m) => m.pending);
  return Panel({ title: "Policy compatibility", iconName: "scale", help: "Agent " + c.agentVersion + ", policy version " + c.policyVersion },
    el("div", { class: "stack" },
      el("p", { class: "callout " + (pending.length ? "warn" : "ok") }, icon(pending.length ? "triangle-alert" : "shield-check"), pending.length ? pending.length + " capability(ies) of this agent are not permitted by the server policy (fail closed). An upgrade never changes the policy." : "The server policy permits everything this agent can do."),
      DataTable({ caption: "Capabilities of the installed agent and what the policy permits", rows: c.capabilities, pageSize: 10, columns: [{ key: "id", label: "Capability", mono: true }, { key: "introducedIn", label: "Since" }, { key: "status", label: "Policy", render: (k) => (k.status === "permitted" ? Badge("permitted", "ok") : Badge("not permitted", "warn")) }, { key: "summary", label: "What it is" }] }),
      ...pending.map((m) => el("div", { class: "stack" }, el("strong", {}, m.id + ": " + m.summary), el("ul", {}, m.grants.map((g) => el("li", {}, g))), el("pre", { class: "diag-text" }, Object.entries(m.changes).map(([k, v]) => k + ": " + JSON.stringify(v.from) + " -> " + JSON.stringify(v.to)).join("\n")), el("p", { class: "muted small" }, "Preview and apply from the CLI: pso environment:policy " + env + " --migrate " + m.id)))));
}
