// Reusable layered graph renderer (SVG). ServiceTopology and ModuleGraph are thin wrappers with different node/edge semantics,
// so runtime service communication and module imports are never drawn in the same graph.

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const k of kids) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}...` : t);

/** Longest-path layering; cycles are tolerated (bounded iterations) because the validator reports them separately. */
function layers(nodes, edges) {
  const level = new Map(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      if (!level.has(e.from) || !level.has(e.to) || e.from === e.to) continue;
      const want = level.get(e.from) + 1;
      if (want > level.get(e.to) && want <= nodes.length) { level.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  return level;
}

export function LayeredGraph({ nodes, edges, selected, onSelect, ariaLabel, kinds = {} }) {
  const W = 224, H = 52, GX = 84, GY = 22, PAD = 20;
  const level = layers(nodes, edges);
  const cols = new Map();
  for (const n of nodes) { const l = level.get(n.id); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(n); }
  const pos = new Map();
  let maxRows = 0;
  for (const [l, list] of cols) { maxRows = Math.max(maxRows, list.length); list.forEach((n, i) => pos.set(n.id, { x: PAD + l * (W + GX), y: PAD + i * (H + GY) })); }
  const width = PAD * 2 + (Math.max(...cols.keys(), 0) + 1) * (W + GX) - GX, height = PAD * 2 + maxRows * (H + GY) - GY;
  const svg = s("svg", { class: "graph", viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": ariaLabel });
  svg.append(s("defs", {}, ...Object.keys({ dep: 1, route: 1, import: 1, broken: 1, ...kinds }).map((k) => s("marker", { id: `arrow-${k}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0 0 L10 5 L0 10 z", class: `arrow ${k}` })))));
  const edgeLayer = s("g", { class: "edges" }), nodeLayer = s("g", { class: "nodes" });
  svg.append(edgeLayer, nodeLayer);
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const forward = b.x > a.x;
    const x1 = forward ? a.x + W : a.x, x2 = forward ? b.x : b.x + W, y1 = a.y + H / 2, y2 = b.y + H / 2, dx = Math.max(36, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
    const path = s("path", { class: `edge ${e.kind}${selected && (e.from === selected || e.to === selected) ? " hot" : ""}`, d: `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, "marker-end": `url(#arrow-${e.kind})` });
    if (e.label) path.append(s("title", {}, e.label));
    edgeLayer.append(path);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const g = s("g", { class: `node ${n.tone ?? "neutral"}${selected === n.id ? " selected" : ""}`, transform: `translate(${p.x} ${p.y})`, role: "button", tabindex: "0", "aria-pressed": String(selected === n.id) });
    g.append(s("rect", { width: W, height: H, rx: 10 }), s("circle", { class: "dot", cx: 16, cy: H / 2, r: 5 }),
      s("text", { class: "t1", x: 30, y: 22 }, clip(n.label, 26)), s("text", { class: "t2", x: 30, y: 40 }, clip(n.sub ?? "", 32)), s("text", { class: "t3", x: 0, y: 0 }, n.status ? `, status ${n.status}` : ""), s("title", {}, `${n.label}${n.status ? ` (${n.status})` : ""}`));
    const pick = () => onSelect?.(n.id);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
    nodeLayer.append(g);
  }
  const scroller = document.createElement("div");
  scroller.className = "graph-scroll"; scroller.tabIndex = 0; scroller.setAttribute("role", "region"); scroller.setAttribute("aria-label", ariaLabel);
  scroller.append(svg);
  return scroller;
}

/** Orchestrator -> services (declared route targets) and service -> service (dependsOn). Node tone is the verified health state. */
export function ServiceTopology({ services, graph, selected, onSelect }) {
  const tone = { healthy: "ok", degraded: "warn", unhealthy: "bad", stopped: "idle", unknown: "unknown" };
  const nodes = services.map((x) => ({ id: x.name, label: x.name, sub: `${x.role} / ${x.runtime} :${x.port}`, tone: tone[x.health.state] ?? "unknown", status: x.health.state }));
  const counts = new Map();
  for (const r of graph.routes) counts.set(`${r.from}>${r.to}`, (counts.get(`${r.from}>${r.to}`) ?? 0) + 1);
  const edges = [
    ...graph.dependencies.map((d) => ({ from: d.from, to: d.to, kind: "dep", label: `${d.from} depends on ${d.to}` })),
    ...[...counts].map(([k, n]) => { const [from, to] = k.split(">"); return { from, to, kind: "route", label: `${n} declared route(s) from ${from} to ${to}` }; }),
  ];
  return LayeredGraph({ nodes, edges, selected, onSelect, ariaLabel: "Service topology" });
}

/** Module imports only. Unresolved imports are drawn to a marked placeholder so a broken reference is visible. */
export function ModuleGraph({ modules, imports, selected, onSelect }) {
  const nodes = modules.map((m) => ({ id: m.name ?? m.dir, label: m.name ?? m.dir, sub: `${m.controllers.length} controllers, ${m.routeCount} routes`, tone: m.diagnostics.some((d) => d.severity === "error") || !m.hasModule ? "bad" : "ok", status: m.diagnostics.length ? `${m.diagnostics.length} diagnostics` : "valid" }));
  const known = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const i of imports) {
    if (!known.has(i.to)) { nodes.push({ id: i.to, label: i.to, sub: "unresolved import", tone: "bad", status: "not found" }); known.add(i.to); }
    edges.push({ from: i.from, to: i.to, kind: i.resolved ? "import" : "broken", label: `${i.from} imports ${i.to}` });
  }
  return LayeredGraph({ nodes, edges, selected, onSelect, ariaLabel: "Module import graph" });
}
