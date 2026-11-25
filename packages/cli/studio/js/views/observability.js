import { api } from "../api.js";
import { el, icon, Badge, CopyButton, DataTable, EmptyState, KeyValues, Panel, SearchField, SelectFilter, fmtTime, openDrawer, setVar, plural } from "../ui.js";
import { Page, DOCS, StackedBar, CommandHint } from "./common.js";

const state = { service: "", levels: new Set(), q: "", correlationId: "", minutes: "" };
const tone = (l) => (l === "error" ? "bad" : l === "warn" ? "warn" : l === "debug" ? "idle" : "neutral");

/** Copy-safe: the server already scrubbed every value; this only formats it. */
const asText = (e) => `${e.ts ?? "-"} [${e.service}] ${e.level.toUpperCase()} ${e.msg}${e.correlationId ? ` correlationId=${e.correlationId}` : ""}${Object.keys(e.fields).length ? ` ${JSON.stringify(e.fields)}` : ""}`;

function openEntry(e, ctx) {
  openDrawer({
    title: e.msg.slice(0, 80) || "Log entry", subtitle: `${e.service} / ${e.level}`, actions: CopyButton(() => asText(e), "Copy"),
    body: el("div", { class: "stack" },
      KeyValues([["Time", e.ts ?? "no timestamp"], ["Service", e.service], ["Level", Badge(e.level, tone(e.level))], ["Format", e.raw ? "plain text line" : "structured JSON"],
        ["Correlation id", e.correlationId ? el("button", { class: "linklike mono", type: "button", onclick: () => { state.correlationId = e.correlationId; ctx.rerender(); } }, `${e.correlationId} (filter by it)`) : "none"]]),
      el("h3", {}, "Message"), el("pre", { class: "logline" }, e.msg),
      Object.keys(e.fields).length ? el("div", {}, el("h3", {}, "Fields"), el("pre", { class: "logline" }, JSON.stringify(e.fields, null, 2))) : null,
      el("p", { class: "muted" }, "Tokens, secrets and key material are scrubbed on the server before display.")),
  });
}

const TELE_TONE = { healthy: "ok", degraded: "warn", unavailable: "bad", "not-configured": "idle", "not-instrumented": "idle", unknown: "neutral" };
const TELE_LABEL = { healthy: "Healthy", degraded: "Degraded", unavailable: "Unavailable", "not-configured": "Not configured", "not-instrumented": "Not instrumented", unknown: "Unknown" };
/** A number appears only when the service really reported it; otherwise the cell says why there is none. Never a zero stand-in. */
/** Dispatch counters and broker health exactly as the service reported them; a service without dispatch says so instead of showing zeros. */
function dispatchCell(r) {
  if (!r.metrics) return el("span", { class: "muted" }, "no data");
  const d = r.metrics.dispatch;
  if (!d) return el("span", { class: "muted" }, "not installed");
  const n = (v) => (v === null || v === undefined ? "n/a" : String(v));
  return el("span", {}, `pub ${n(d.published)} / cons ${n(d.consumed)} / retry ${n(d.retried)} / DLQ ${n(d.deadLettered)} `, Badge(`broker ${d.health}`, d.health === "up" ? "ok" : d.health === "down" ? "bad" : "neutral"));
}

const num = (r, pick) => (r.metrics ? String(pick(r.metrics)) : el("span", { class: "muted" }, "no data"));

function telemetryPanel(t) {
  return Panel({ title: "Runtime telemetry", iconName: "activity", help: t.note },
    DataTable({
      caption: "Runtime telemetry per service", rows: t.services, pageSize: 20,
      columns: [
        { key: "service", label: "Service" },
        { key: "state", label: "State", render: (r) => Badge(TELE_LABEL[r.state] ?? r.state, TELE_TONE[r.state] ?? "neutral") },
        { key: "requests", label: "Requests", render: (r) => num(r, (m) => m.requests) },
        { key: "serverErrors", label: "5xx", render: (r) => num(r, (m) => m.serverErrors) },
        { key: "rateLimited", label: "Rate limited", render: (r) => num(r, (m) => m.rateLimited) },
        { key: "dispatch", label: "Dispatch", render: dispatchCell },
        { key: "avg", label: "Avg latency", render: (r) => (r.metrics && r.metrics.avgLatencyMs !== null ? `${r.metrics.avgLatencyMs} ms` : el("span", { class: "muted" }, "no data")) },
        { key: "reason", label: "Why", cls: "wrap-cell" },
      ],
      empty: EmptyState({ title: "No services declared", text: "Declare services in pso.workspace.json.", iconName: "activity" }),
    }));
}

export async function observabilityView(ctx) {
  const p = { limit: 500, service: state.service || undefined, level: [...state.levels].join(",") || undefined, q: state.q || undefined, correlationId: state.correlationId || undefined, minutes: state.minutes || undefined };
  const [d, all, tel] = await Promise.all([api.logs(p), api.logs({ limit: 1000 }), api.telemetry()]);
  const counts = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const e of all.entries) counts[e.level] = (counts[e.level] ?? 0) + 1;
  const rows = [...d.entries].reverse(); // newest first
  const levelToggle = (l) => el("button", { class: `chip-toggle ${tone(l)}`, type: "button", "aria-pressed": String(state.levels.has(l)), onclick: () => { state.levels.has(l) ? state.levels.delete(l) : state.levels.add(l); ctx.rerender(); } }, l);
  return Page({ title: "Observability", question: "What did my services log, and can I follow one request across them?", docs: { path: DOCS.logs, text: "Auditing docs" },
    actions: CopyButton(() => rows.slice(0, 200).map(asText).join("\n"), "Copy visible") },
    telemetryPanel(tel),
    all.services.length === 0
      ? EmptyState({ title: "No log files yet", text: "Service output is written to .pso/logs while pso dev runs. Nothing is simulated here.", iconName: "scroll-text", action: CommandHint("pso dev") })
      : el("div", { class: "stack" },
        Panel({ title: "Log levels", iconName: "chart-no-axes-column", help: `Counts from the last lines of every log file (${plural(all.entries.length, "line")}). Unstructured lines are classified by keyword.` },
          StackedBar([{ label: "error", value: counts.error, tone: "bad" }, { label: "warn", value: counts.warn, tone: "warn" }, { label: "info", value: counts.info, tone: "ok" }, { label: "debug", value: counts.debug, tone: "idle" }], "Log levels")),
        el("div", { class: "toolbar" },
          SearchField({ label: "Search logs", value: state.q, placeholder: "Search message and fields", onchange: (v) => { state.q = v; ctx.rerender(); } }),
          SelectFilter({ label: "Service", value: state.service, options: [["", "All services"], ...d.services.map((s) => [s, s])], onchange: (v) => { state.service = v; ctx.rerender(); } }),
          SelectFilter({ label: "Time range", value: state.minutes, options: [["", "All time"], ["5", "Last 5 min"], ["15", "Last 15 min"], ["60", "Last hour"], ["1440", "Last 24 h"]], onchange: (v) => { state.minutes = v; ctx.rerender(); } }),
          el("label", { class: "field" }, el("span", {}, "Correlation id"), el("input", { type: "text", value: state.correlationId, placeholder: "uuid", spellcheck: "false", "aria-label": "Correlation id", onchange: (e) => { state.correlationId = e.target.value.trim(); ctx.rerender(); } })),
          el("div", { class: "field", role: "group", "aria-label": "Severity" }, el("span", {}, "Severity"), el("div", { class: "row" }, ["error", "warn", "info", "debug"].map(levelToggle)))),
        d.note ? el("p", { class: "muted" }, d.note) : null,
        el("p", { class: "muted", role: "status" }, `${plural(d.total, "entry", "entries")} match${d.truncated ? ` (showing the newest ${d.entries.length})` : ""}.`),
        DataTable({
          caption: "Log entries, newest first", rows, pageSize: 50, onRowClick: (e) => openEntry(e, ctx), rowLabel: (e) => `Inspect log entry: ${e.msg.slice(0, 60)}`,
          columns: [
            { key: "ts", label: "Time", render: (e) => fmtTime(e.ts), mono: true },
            { key: "level", label: "Level", render: (e) => Badge(e.level, tone(e.level)) },
            { key: "service", label: "Service" },
            { key: "msg", label: "Message", cls: "wrap-cell" },
            { key: "correlationId", label: "Correlation", mono: true, render: (e) => (e.correlationId ? e.correlationId.slice(0, 8) : "-") },
          ],
          empty: EmptyState({ title: "No entries match", text: "Clear a filter to widen the search.", iconName: "search-x" }),
        })));
}
