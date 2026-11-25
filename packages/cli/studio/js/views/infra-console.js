// Infrastructure console: environments, resources, hosts, certificates, containers and deployment, read from the same engine as
// `pso infra:*`, `pso docker:*` and `pso deploy --env`. Operations exist only when Studio runs with --ops, and each needs a typed confirmation.
import { api } from "../api.js";
import { el, icon, Badge, Button, DataTable, EmptyState, KeyValues, Panel, toast } from "../ui.js";
import { Page, CommandHint, code } from "./common.js";

const STATUS_TONE = { ok: "ok", "external-ok": "ok", missing: "bad", invalid: "bad", exposed: "bad", "external-missing": "bad", drifted: "warn", outdated: "warn", "external-unverified": "neutral", blocked: "bad" };
const statusBadge = (s) => Badge(s, STATUS_TONE[s] ?? "neutral");
const store = { get: () => { try { return sessionStorage.getItem("pso-studio-infra-env") ?? ""; } catch { return ""; } }, set: (v) => { try { sessionStorage.setItem("pso-studio-infra-env", v); } catch { /* storage blocked */ } } };

/** The environment picker shared by every infrastructure page (its own list: the environments of pso.infra.json). */
async function envPicker(ctx) {
  const e = await api.infraEnvironments();
  const current = store.get() && e.environments.some((x) => x.name === store.get()) ? store.get() : (e.environments.find((x) => x.default) ?? e.environments[0])?.name;
  const select = el("select", { "aria-label": "Infrastructure environment", onchange: (ev) => { store.set(ev.target.value); ctx.rerender(); } }, e.environments.map((x) => el("option", { value: x.name, ...(x.name === current ? { selected: true } : {}) }, `${x.name} (${x.kind})`)));
  return { env: current, envs: e, picker: el("label", { class: "field" }, el("span", { class: "muted small" }, "Environment"), select) };
}
const notDeclared = (title) => EmptyState({ title, text: "This workspace has no pso.infra.json yet: PSO derives a single local development environment. Create the contract to declare environments, hosts, the identity provider and TLS.", iconName: "layers", action: el("div", { class: "stack" }, CommandHint("pso infra:init"), CommandHint("pso workspace:migrate")) });

/** Typed confirmation: the user types "<action> <target>" before an operation is sent. */
function confirmAction({ action, target, label, variant = "", onrun, extra }) {
  const input = el("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: `${action} ${target}`, "aria-label": `Type "${action} ${target}" to confirm` });
  const btn = Button({ label, iconName: action === "apply" ? "play" : action === "repair" ? "wrench" : action === "rotate" ? "rotate-cw" : action === "down" || action === "stop" ? "square" : "play", variant, onclick: async () => {
    if (input.value.trim() !== `${action} ${target}`) { toast(`Type "${action} ${target}" to confirm`, "bad"); input.focus(); return; }
    btn.setAttribute("disabled", "");
    try { await onrun(input.value.trim()); } catch (e) { toast(e.message, "bad"); } finally { btn.removeAttribute("disabled"); input.value = ""; }
  } });
  return el("div", { class: "row wrap" }, input, btn, extra ?? null);
}

// ------------------------------------------------------------------------------------------------------------------------- Infrastructure
export async function infrastructureView(ctx) {
  const { env, envs, picker } = await envPicker(ctx);
  if (!envs.declared && envs.environments.length === 1) {
    // even without a contract the derived environment can be planned
  }
  const d = await api.infra(env);
  if (d.error) return Page({ title: "Infrastructure", question: "What does this environment need, and is it all there?" }, el("p", { class: "callout bad" }, icon("circle-x"), d.error));
  const s = d.summary, t = d.topology;
  const byModule = {};
  for (const r of d.resources) (byModule[r.module] ??= []).push(r);
  const out = el("div", { class: "stack" });
  const ops = envs.opsEnabled ? Panel({ title: "Operations", iconName: "wrench", help: "Each operation runs exactly what the CLI runs (pso infra:apply / infra:repair). Development material is generated only for development environments; operator-supplied resources are never written." },
    el("div", { class: "stack" },
      el("div", {}, el("strong", {}, "Provision"), el("p", { class: "muted small" }, `Creates what is missing and authorized, updates configuration whose declarations changed. ${s.changes} change(s) pending.`), confirmAction({ action: "apply", target: d.environment, label: "Apply", onrun: async (confirm) => { const r = await api.infraOp({ action: "apply", env: d.environment, confirm, ...(d.kind !== "development" ? { acknowledgeEnvironment: d.environment } : {}) }); toast(`${r.applied.filter((a) => a.result === "done").length} resource(s) changed${r.restart.length ? `; restart ${r.restart.join(", ")}` : ""}`); ctx.rerender(); } })),
      el("div", {}, el("strong", {}, "Repair drift"), el("p", { class: "muted small" }, `Regenerates managed files edited by hand (the edited copy is backed up). ${s.drift} drifted.`), confirmAction({ action: "repair", target: d.environment, label: "Repair", variant: "ghost", onrun: async (confirm) => { const r = await api.infraOp({ action: "repair", env: d.environment, confirm, ...(d.kind !== "development" ? { acknowledgeEnvironment: d.environment } : {}) }); toast(`repaired ${r.applied.filter((a) => a.result === "done").length} resource(s)${r.backups.length ? `; backups: ${r.backups.length}` : ""}`); ctx.rerender(); } })))) : el("p", { class: "callout info" }, icon("shield-check"), "Read-only. Start Studio with `pso studio --ops` to provision, repair, rotate and run containers from these pages (every operation asks for a typed confirmation).");
  const validation = el("div", {});
  out.append(
    el("div", { class: "metrics" },
      el("div", { class: `metric ${s.changes ? "warn" : "ok"}` }, el("div", { class: "metric-head" }, icon("layers"), "Pending changes"), el("div", { class: "metric-value" }, String(s.changes))),
      el("div", { class: `metric ${s.drift ? "warn" : "ok"}` }, el("div", { class: "metric-head" }, icon("file-lock"), "Drifted files"), el("div", { class: "metric-value" }, String(s.drift))),
      el("div", { class: `metric ${s["external-missing"] ? "bad" : "ok"}` }, el("div", { class: "metric-head" }, icon("plug"), "To supply"), el("div", { class: "metric-value" }, String(s["external-missing"]))),
      el("div", { class: "metric neutral" }, el("div", { class: "metric-head" }, icon("server"), "Resources"), el("div", { class: "metric-value" }, String(d.resources.length)))),
    ops,
    Panel({ title: "Environment", iconName: "globe" }, KeyValues([["Kind", d.kind], ["Domain", code(t.domain)], ["Runtime", t.runtime], ["TLS", t.tlsSource ?? t.tls], ["Secrets", t.secrets], ["Compose project", code(t.project)], ["API", code(t.api.origin)], ["Identity", t.identity ? `${t.identity.provider} — issuer ${t.identity.issuer}` : "none"], ["Interrupted provisioning", d.interrupted.length ? Badge(d.interrupted.join(", "), "warn") : "none"]])),
    Panel({ title: "Validation", iconName: "stethoscope", actions: [Button({ label: "Validate", iconName: "refresh-cw", onclick: async () => { validation.replaceChildren(el("p", { class: "muted" }, "Validating…")); const v = await api.infraValidate(d.environment, false); validation.replaceChildren(findings(v)); } }), Button({ label: "Validate + probe running environment", iconName: "activity", variant: "ghost", onclick: async () => { validation.replaceChildren(el("p", { class: "muted" }, "Probing the running environment through the edge…")); const v = await api.infraValidate(d.environment, true); validation.replaceChildren(findings(v)); } })] }, validation),
    ...Object.entries(byModule).map(([mod, rows]) => Panel({ title: mod, iconName: "layers" }, DataTable({ caption: `Resources: ${mod}`, columns: [
      { key: "id", label: "Resource", render: (r) => code(r.id) }, { key: "status", label: "Status", render: (r) => statusBadge(r.status) }, { key: "owner", label: "Owner" },
      { key: "action", label: "Next", render: (r) => (r.action === "none" ? "-" : r.action) }, { key: "description", label: "What", render: (r) => el("span", {}, r.description, r.reasons.length ? el("div", { class: "muted small" }, r.reasons.join("; ")) : null, r.warnings.length ? el("div", { class: "small warn" }, r.warnings.join("; ")) : null) }],
    rows, pageSize: 20 }))),
    Panel({ title: "From the CLI", iconName: "terminal" }, el("div", { class: "stack" }, CommandHint(`pso infra:plan --env ${d.environment}`), CommandHint(`pso infra:apply --env ${d.environment}`), CommandHint(`pso infra:validate --env ${d.environment} --probe`), CommandHint(`pso infra:inspect --env ${d.environment}`))));
  return Page({ title: "Infrastructure", question: "What does this environment need, who owns each resource, and is everything present and valid?", docs: { path: "infrastructure/overview.html", text: "Infrastructure engine" }, actions: [picker] }, out);
}

function findings(v) {
  if (v.error) return el("p", { class: "callout bad" }, v.error);
  return el("div", { class: "stack" },
    el("p", {}, v.ok ? Badge("valid", "ok") : Badge("errors found", "bad"), " ", `environment ${v.environment}`),
    v.findings.length ? el("ul", { class: "diag-list" }, v.findings.map((f) => el("li", { class: "diag-card" }, el("div", { class: "row wrap" }, Badge(f.severity, f.severity === "error" ? "bad" : f.severity === "warning" ? "warn" : "neutral"), el("strong", { class: "mono" }, f.code), el("span", { class: "mono muted" }, f.subject)), el("p", {}, f.message), f.hint ? el("p", { class: "muted small" }, icon("lightbulb"), " ", f.hint) : null))) : el("p", { class: "muted" }, "No findings."),
    v.probes.length ? DataTable({ caption: "Live probes", columns: [{ key: "name", label: "Probe" }, { key: "ok", label: "Result", render: (p) => Badge(p.ok ? "ok" : "failed", p.ok ? "ok" : "bad") }, { key: "detail", label: "Detail" }, { key: "timeMs", label: "ms", render: (p) => (p.timeMs ?? "-") }], rows: v.probes, pageSize: 20 }) : null);
}

// ------------------------------------------------------------------------------------------------------------------------------ Containers
export async function containersView(ctx) {
  const { env, envs, picker } = await envPicker(ctx);
  if (!envs.declared) return Page({ title: "Containers", question: "Which containers run, in what order, and are they healthy?" }, notDeclared("No container topology yet"));
  const d = await api.containers(env);
  if (d.error) return Page({ title: "Containers" }, el("p", { class: "callout bad" }, d.error));
  const logBox = el("pre", { class: "log-view", "aria-live": "polite", tabindex: "0" }, "Select a container to see its log (credentials and secret values are masked).");
  const showLogs = async (name) => { logBox.textContent = `loading ${name}…`; const r = await api.containerLogs(d.environment, name, 300); logBox.textContent = r.error ? r.error : r.lines.join("\n") || "(empty)"; };
  const byName = Object.fromEntries(d.containers.map((c) => [c.service, c]));
  // the service name is what every command takes; Docker's own container name is only a detail
  const rows = d.order.map((n, i) => ({ ...(byName[n] ?? { state: "not created", health: "", status: "", ports: "" }), order: i + 1, name: n, container: byName[n]?.name ?? "" }));
  const opBtn = (action, names) => confirmAction({ action, target: names.length ? names.join(",") : d.environment, label: action === "up" ? (names.length ? "Start" : "Start all") : action === "restart" ? "Restart" : action === "stop" ? "Stop" : "Stop all", variant: action === "up" ? "" : "ghost", onrun: async (confirm) => { const r = await api.containerOp({ action, env: d.environment, services: names, confirm }); toast(r.ok ? `${action}: done` : `${action} failed (exit ${r.exitCode})`, r.ok ? "ok" : "bad"); ctx.rerender(); } });
  const sel = el("select", { "aria-label": "Container" }, d.order.map((n) => el("option", { value: n }, n)));
  const one = el("div", { class: "stack" });
  return Page({ title: "Containers", question: "Which containers run, in what order, and are they healthy?", docs: { path: "infrastructure/containers.html", text: "Container engine" }, actions: [picker] },
    d.docker.ok ? null : el("p", { class: "callout bad" }, icon("circle-x"), `Docker is not usable: ${d.docker.reason}`),
    d.generated ? null : el("p", { class: "callout warn" }, icon("triangle-alert"), "The compose file of this environment has not been generated yet: Infrastructure > Apply, or pso infra:apply."),
    Panel({ title: "Topology (dependency order)", iconName: "container" }, DataTable({ caption: "Containers", columns: [
      { key: "order", label: "#" }, { key: "name", label: "Container", render: (r) => el("button", { class: "link", type: "button", onclick: () => showLogs(r.name) }, r.name) },
      { key: "state", label: "State", render: (r) => Badge(r.state || "-", r.state === "running" ? "ok" : r.state === "not created" ? "neutral" : "warn") },
      { key: "health", label: "Health", render: (r) => (r.health ? Badge(r.health, r.health === "healthy" ? "ok" : r.health === "starting" ? "warn" : "bad") : "-") },
      { key: "status", label: "Status" }, { key: "ports", label: "Published", render: (r) => (r.ports && /->/.test(r.ports) ? code(r.ports) : "-") }], rows, pageSize: 30 })),
    envs.opsEnabled ? Panel({ title: "Operations", iconName: "play", help: "Start uses the generated topology and waits for health; restart touches only the selected container; stop all keeps database volumes (deleting them is a CLI-only action: pso docker:down --volumes --yes)." },
      el("div", { class: "stack" }, el("div", {}, el("strong", {}, "Whole environment"), opBtn("up", []), opBtn("down", [])),
        el("div", {}, el("strong", {}, "One container"), el("div", { class: "row wrap" }, sel, Button({ label: "Prepare", iconName: "chevron-right", variant: "ghost", onclick: () => { one.replaceChildren(opBtn("restart", [sel.value]), opBtn("up", [sel.value]), opBtn("stop", [sel.value])); } })), one)))
      : el("p", { class: "callout info" }, icon("shield-check"), "Read-only: start Studio with `pso studio --ops` to start, stop and restart containers from here."),
    Panel({ title: "Log", iconName: "scroll-text", actions: [Button({ label: "Show", iconName: "refresh-cw", variant: "ghost", onclick: () => showLogs(sel.value) })] }, logBox),
    Panel({ title: "From the CLI", iconName: "terminal" }, el("div", { class: "stack" }, CommandHint(`pso docker:plan --env ${d.environment}`), CommandHint(`pso docker:up --env ${d.environment}`), CommandHint(`pso docker:restart edge --env ${d.environment}`), CommandHint(`pso docker:logs gateway --env ${d.environment}`))));
}

// ----------------------------------------------------------------------------------------------------------------------------------- Hosts
export async function hostsView(ctx) {
  const { env, picker } = await envPicker(ctx);
  const d = await api.hosts(env);
  if (d.error) return Page({ title: "Hosts" }, el("p", { class: "callout bad" }, d.error));
  return Page({ title: "Hosts", question: "Under which names is each frontend, the API and the identity provider reached, and how do the components reach each other?", docs: { path: "infrastructure/hosts-and-environments.html", text: "Hosts and environments" }, actions: [picker] },
    el("p", { class: "callout info" }, icon("globe"), d.note),
    Panel({ title: "Public hosts", iconName: "globe" }, DataTable({ caption: "Public hosts", columns: [{ key: "host", label: "Host", render: (r) => code(r.host) }, { key: "role", label: "Serves" }, { key: "url", label: "URL", render: (r) => code(r.url) }], rows: d.hosts })),
    Panel({ title: "Service addresses", iconName: "network", help: "Containers reach each other by service name on the private network, never through localhost (a container's localhost is itself). Local processes (pso dev) use the loopback address." },
      DataTable({ caption: "Addresses", columns: [{ key: "name", label: "Service" }, { key: "container", label: "From a container", render: (r) => code(r.container) }, { key: "process", label: "From a local process", render: (r) => code(r.process) }], rows: d.internal })),
    d.hostsFile ? Panel({ title: "Hosts file", iconName: "file-lock" }, KeyValues([["File", code(d.hostsFile.file)], ["PSO block present", d.hostsFile.present ? Badge("yes", "ok") : Badge("no", "neutral")]]), el("pre", { class: "diag-text" }, d.hostsFile.block), CommandHint(`pso infra:hosts --env ${d.environment} --apply --yes`)) : null);
}

// ---------------------------------------------------------------------------------------------------------------------------- Certificates
export async function certificatesView(ctx) {
  const { env, envs, picker } = await envPicker(ctx);
  const d = await api.certificates(env);
  if (d.error) return Page({ title: "Certificates and secrets" }, el("p", { class: "callout bad" }, d.error));
  const certs = d.rows.filter((r) => r.kind === "ca" || r.kind === "certificate"), secrets = d.rows.filter((r) => r.kind === "secret" || r.kind === "signing-key");
  const rotate = (r) => envs.opsEnabled && r.owner === "pso" && d.kind === "development" ? confirmAction({ action: "rotate", target: r.id, label: "Rotate", variant: "ghost", onrun: async (confirm) => { const x = await api.infraOp({ action: "rotate", env: d.environment, resource: r.id, confirm }); toast(`rotated ${r.id}${x.restart.length ? `; restart ${x.restart.join(", ")}` : ""}`); ctx.rerender(); } }) : null;
  return Page({ title: "Certificates and secrets", question: "Which keys, certificates and secrets does this environment use, who supplies them, and when do they expire?", docs: { path: "infrastructure/security-and-certificates.html", text: "Security model" }, actions: [picker] },
    el("p", { class: "callout info" }, icon("lock"), "Private keys and secret values are never sent to this page: certificates are identified by fingerprint, names and dates, secrets by their source and length."),
    Panel({ title: "Authorities and certificates", iconName: "key-round" }, DataTable({ caption: "Certificates", columns: [
      { key: "id", label: "Certificate", render: (r) => code(r.id) }, { key: "status", label: "Status", render: (r) => statusBadge(r.status) }, { key: "owner", label: "Owner" },
      { key: "names", label: "Names", render: (r) => (r.names.length ? r.names.join(", ") : "-") }, { key: "daysLeft", label: "Expires", render: (r) => (r.notAfter ? el("span", {}, String(r.notAfter).slice(0, 10), " ", Badge(`${r.daysLeft} d`, r.daysLeft < 30 ? "warn" : "ok")) : "-") },
      { key: "fingerprint", label: "SHA-256", render: (r) => (r.fingerprint ? el("span", { class: "mono small" }, String(r.fingerprint).slice(0, 23) + "…") : "-") }, { key: "rotate", label: "", render: rotate }], rows: certs, pageSize: 25 })),
    Panel({ title: "Secrets and keys", iconName: "file-lock" }, DataTable({ caption: "Secrets", columns: [
      { key: "id", label: "Secret", render: (r) => code(r.id) }, { key: "status", label: "Status", render: (r) => statusBadge(r.status) }, { key: "owner", label: "Owner" },
      { key: "source", label: "Source", render: (r) => (r.source ? code(String(r.source)) : "-") }, { key: "length", label: "Length", render: (r) => (r.length ? `${r.length} chars` : "-") }, { key: "rotate", label: "", render: rotate }], rows: secrets, pageSize: 25 })));
}

// ------------------------------------------------------------------------------------------------------------------------------ Deployment
export async function deploymentView(ctx) {
  const { env, envs, picker } = await envPicker(ctx);
  if (!envs.declared) return Page({ title: "Deployment" }, notDeclared("No environments declared"));
  const d = await api.deployment(env);
  if (d.error) return Page({ title: "Deployment" }, el("p", { class: "callout bad" }, d.error));
  return Page({ title: "Deployment", question: "What would deploying this environment do, what is missing, and which releases exist?", docs: { path: "infrastructure/deployment.html", text: "Deployment" }, actions: [picker] },
    Panel({ title: `Plan: ${d.environment} (${d.kind}) to ${d.target}`, iconName: "rocket" },
      el("ol", { class: "plain-list" }, d.steps.map((s) => el("li", {}, s))),
      d.blockers.length ? el("div", { class: "callout bad" }, el("strong", {}, "Blocked"), el("ul", {}, d.blockers.map((b) => el("li", {}, b)))) : el("p", {}, Badge("no blocker", "ok")),
      d.prerequisites.length ? el("div", { class: "callout warn" }, el("strong", {}, "Prerequisites verified on the target"), el("ul", {}, d.prerequisites.map((b) => el("li", {}, b)))) : null,
      el("p", { class: "muted small" }, "Deployments run from the CLI (they build images, start containers and verify through the edge, with automatic rollback): Studio shows the plan only."),
      CommandHint(`pso deploy --env ${d.environment} --dry-run`), CommandHint(`pso deploy --env ${d.environment} --yes`)),
    Panel({ title: "Frontend publication", iconName: "panels-top-left" }, DataTable({ caption: "Shells", columns: [{ key: "name", label: "FEI" }, { key: "url", label: "URL", render: (r) => code(r.url) }, { key: "published", label: "Release published", render: (r) => Badge(r.published ? "yes" : "no", r.published ? "ok" : "warn") }], rows: d.frontends })),
    Panel({ title: "Releases", iconName: "history" }, d.releases.length ? DataTable({ caption: "Recorded releases", columns: [{ key: "id", label: "Release", render: (r) => code(r.id) }, { key: "at", label: "Recorded" }, { key: "active", label: "", render: (r) => (r.active ? Badge("active", "ok") : "") }], rows: [...d.releases].reverse() }) : el("p", { class: "muted" }, "No release recorded for this environment yet.")));
}
