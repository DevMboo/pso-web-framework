import { api } from "../api.js";
import { LayeredGraph } from "../graph.js";
import { el, icon, Badge, Button, CopyButton, DataTable, EmptyState, KeyValues, Panel, StatusIndicator, openDrawer, toast } from "../ui.js";
import { Page, DOCS, CommandHint, code } from "./common.js";

let selected = null;
let live = null;

const sevTone = (s) => (s === "error" ? "bad" : s === "warning" ? "warn" : "neutral");

function openChannel(d, name) {
  const ch = d.channels.find((c) => c.name === name);
  if (!ch) return;
  selected = name;
  openDrawer({
    title: ch.name, subtitle: "channel (stream / exchange / topic)",
    actions: CopyButton(() => `${ch.name}: events ${ch.events.join(", ")}; publishers ${ch.publishers.join(", ") || "-"}; consumers ${ch.consumers.map((c) => `${c.service}/${c.handler}`).join(", ") || "-"}`, "Copy"),
    body: el("div", { class: "stack" },
      KeyValues([["Events", ch.events.map((e) => el("span", { class: "chip mono" }, e))], ["Dead-letter", code(ch.deadLetter)], ["Publishers", ch.publishers.join(", ") || "none declared"]]),
      el("h3", {}, `Consumers (${ch.consumers.length})`),
      ch.consumers.length ? el("ul", { class: "plain" }, ch.consumers.map((c) => el("li", {}, el("a", { href: `#/services/${c.service}` }, c.service), ` handles `, code(c.event), ` with ${c.handler}, group `, code(c.group)))) : el("p", { class: "muted" }, "No consumer is declared for this channel."),
      el("p", { class: "callout info" }, icon("info"), "This is the declared topology read from source files. It does not say whether messages are flowing."),
      el("div", { class: "row wrap" }, CommandHint("pso dispatch:graph"), el("a", { class: "doc-link", href: `/docs/${DOCS.dispatch}`, target: "_blank", rel: "noopener" }, icon("book-open"), "Dispatch docs"))),
  });
}

function Topology(d) {
  const serviceNodes = d.services.filter((s) => s.events.length || s.consumers.length).map((s) => ({ id: s.service, label: s.service, sub: `${s.provider === "none" ? "no provider" : s.provider}${s.enabled ? "" : ", disabled"}`, tone: s.enabled ? "ok" : "idle", status: s.enabled ? "enabled" : "disabled" }));
  const channelNodes = d.channels.map((c) => ({ id: `channel:${c.name}`, label: c.name, sub: `${c.events.length} event type(s)`, tone: "neutral", status: "channel" }));
  const nodes = [...serviceNodes, ...channelNodes];
  if (!nodes.length) return EmptyState({ title: "No events declared", text: "Declare events in a service (EVENTS.pso.ts or dispatch/*.events.json) to see the topology.", iconName: "workflow" });
  const edges = d.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind === "publishes" ? "route" : "dep", label: `${e.event} (${e.kind})` }));
  return LayeredGraph({ nodes, edges, selected: selected ? `channel:${selected}` : null, ariaLabel: "Event topology", onSelect: (id) => { if (id.startsWith("channel:")) openChannel(d, id.slice(8)); else location.hash = `#/services/${id}`; } });
}

export async function dispatchView(ctx) {
  const d = await api.dispatch(live ? { probe: 1 } : {});
  const probeButton = Button({ label: live ? "Re-check broker connections" : "Check broker connections", iconName: "plug-zap", onclick: async () => { live = true; toast("Connecting to the configured brokers..."); ctx.rerender(); } });
  if (!d.services.length || (!d.anyInstalled && !d.channels.length)) {
    return Page({ title: "Dispatch", question: "Which events, producers and consumers exist, and which provider carries them?", docs: { path: DOCS.dispatch } },
      EmptyState({ title: "Dispatch is not installed", text: "No service has a dispatch provider or declares events. Dispatch is optional: nothing connects to a broker unless you install a provider and enable it.", iconName: "workflow", action: CommandHint("pso dispatch:install <redis|rabbitmq|kafka>") }));
  }
  const findings = d.services.flatMap((s) => s.findings.map((f) => ({ ...f, service: s.service })));
  return Page({ title: "Dispatch", question: "Which events, producers and consumers are declared, and is the provider reachable?", docs: { path: DOCS.dispatch }, actions: probeButton },
    el("p", { class: "callout info" }, icon("info"), d.liveNote),
    el("p", { class: "callout warn" }, icon("triangle-alert"), d.telemetry.reason),
    Panel({ title: "Event topology", iconName: "network", help: "Services publish to channels and consume from them. Select a channel for its events, consumers and dead-letter destination." }, Topology(d)),
    el("div", { class: "cols" },
      Panel({ title: "Providers", iconName: "plug" }, DataTable({
        caption: "Providers per service", rows: d.services, pageSize: 15, onRowClick: (s) => { location.hash = `#/services/${s.service}`; }, rowLabel: (s) => `Open ${s.service}`,
        columns: [
          { key: "service", label: "Service", render: (s) => el("strong", {}, s.service) },
          { key: "provider", label: "Provider", render: (s) => (s.provider === "none" ? el("span", { class: "muted" }, "none") : Badge(s.provider, "ok")) },
          { key: "installedAdapter", label: "Adapter", render: (s) => s.installedAdapter ?? "not installed" },
          { key: "enabled", label: "State", render: (s) => (s.enabled ? Badge("enabled", "ok") : Badge("disabled", "idle", "Nothing connects while disabled")) },
          { key: "connection", label: "Connection", sortable: false, render: (s) => { const l = live ? d.live?.find((x) => x.service === s.service) : null; return l ? el("span", { title: l.detail }, StatusIndicator(l.status === "up" ? "healthy" : l.status === "down" ? "unhealthy" : "unknown"), l.ms !== undefined ? ` ${l.ms} ms` : "") : el("span", { class: "muted" }, "not checked"); } },
        ],
      })),
      Panel({ title: "Connection check", iconName: "plug-zap", help: "A real connection attempt using the same adapters the services use, with the environment of this machine." },
        d.live ? el("ul", { class: "plain" }, d.live.map((l) => el("li", {}, StatusIndicator(l.status === "up" ? "healthy" : l.status === "down" ? "unhealthy" : "unknown"), " ", el("strong", {}, l.service), ` (${l.provider}): ${l.detail}`)))
          : el("p", { class: "muted" }, "Not checked yet. The declared configuration alone never proves a connection."))),
    el("div", { class: "cols" },
      Panel({ title: "Events", iconName: "workflow" }, d.channels.length ? DataTable({
        caption: "Declared events", pageSize: 15, rows: d.services.flatMap((s) => s.events.map((e) => ({ ...e, service: s.service }))),
        columns: [{ key: "name", label: "Event", mono: true }, { key: "version", label: "Version" }, { key: "channel", label: "Channel", mono: true, render: (e) => el("button", { class: "linklike mono", type: "button", onclick: () => openChannel(d, e.channel) }, e.channel) }, { key: "service", label: "Service" }, { key: "publish", label: "Role", render: (e) => (e.publish ? "publishes" : "consume only") }, { key: "compatibility", label: "Compatibility" }, { key: "hasSchema", label: "Schema", render: (e) => (e.hasSchema ? "yes" : "none") }],
      }) : EmptyState({ title: "No events", iconName: "workflow" })),
      Panel({ title: "Consumers", iconName: "inbox" }, d.services.some((s) => s.consumers.length) ? DataTable({
        caption: "Declared consumers", pageSize: 15, rows: d.services.flatMap((s) => s.consumers.map((c) => ({ ...c, service: s.service }))),
        columns: [{ key: "event", label: "Event", mono: true }, { key: "service", label: "Service" }, { key: "handler", label: "Handler", mono: true }, { key: "group", label: "Group", mono: true }],
      }) : EmptyState({ title: "No consumers", iconName: "inbox" }))),
    Panel({ title: `Findings (${findings.length})`, iconName: "stethoscope", help: "Static validation: declarations, schemas, consumers, providers and the contract lock.", actions: CommandHint("pso dispatch:validate") },
      findings.length ? el("ul", { class: "plain" }, findings.map((f) => el("li", { class: "diag" }, Badge(f.code, sevTone(f.severity)), el("span", {}, `${f.service}: ${f.message}`), f.hint ? el("span", { class: "muted small" }, `Fix: ${f.hint}`) : null))) : el("p", { class: "muted" }, "No findings.")));
}
