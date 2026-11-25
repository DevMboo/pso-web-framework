// Presentational building blocks. Nothing here talks to the network or knows about PSO data shapes beyond what it renders.
// Every text value goes through textContent / createTextNode: log lines, config and routes are never interpreted as markup.

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

/** Lucide icon rendered through a CSS mask so it inherits currentColor. The name is validated; the URL is set through CSSOM (CSP-safe). */
export function icon(name, cls = "") {
  const n = el("span", { class: `icon ${cls}`.trim(), "aria-hidden": "true" });
  if (/^[a-z0-9-]{1,48}$/.test(name)) n.style.setProperty("--icon", `url(/icons/${name}.svg)`);
  return n;
}

/** Sets a CSS length through CSSOM so no inline style attribute is needed. */
export function setVar(node, name, value) { node.style.setProperty(name, value); return node; }

export const STATES = {
  healthy: { label: "Healthy", icon: "circle-check", cls: "ok" },
  degraded: { label: "Degraded", icon: "triangle-alert", cls: "warn" },
  unhealthy: { label: "Unhealthy", icon: "circle-x", cls: "bad" },
  stopped: { label: "Stopped", icon: "circle-stop", cls: "idle" },
  unknown: { label: "Unknown", icon: "circle-help", cls: "unknown" },
};

/** Status is never conveyed by color alone: icon + text are always present. */
export function StatusIndicator(state, opts = {}) {
  const s = STATES[state] ?? STATES.unknown;
  return el("span", { class: `status ${s.cls}${opts.compact ? " compact" : ""}`, title: opts.reason ?? s.label }, icon(s.icon), opts.compact ? el("span", { class: "sr-only" }, s.label) : s.label);
}

export function Badge(text, tone = "neutral", title) { return el("span", { class: `badge ${tone}`, ...(title ? { title } : {}) }, text); }
export const MethodBadge = (m) => el("span", { class: `method m-${String(m).toLowerCase()}` }, m);

export function MetricCard({ label, value, hint, tone = "neutral", href, iconName }) {
  const body = [el("div", { class: "metric-head" }, iconName ? icon(iconName) : null, el("span", {}, label)), el("div", { class: `metric-value${String(value).length > 9 ? " long" : ""}` }, value), hint ? el("div", { class: "metric-hint" }, hint) : null];
  return href ? el("a", { class: `metric ${tone}`, href }, body) : el("div", { class: `metric ${tone}` }, body);
}

export function Panel({ title, iconName, actions, help, className = "" }, ...body) {
  return el("section", { class: `panel ${className}`.trim() },
    title ? el("header", { class: "panel-head" }, el("h2", {}, iconName ? icon(iconName) : null, title), actions ? el("div", { class: "panel-actions" }, actions) : null) : null,
    help ? el("p", { class: "help" }, help) : null, el("div", { class: "panel-body" }, body));
}

export function EmptyState({ title, text, iconName = "inbox", action }) {
  return el("div", { class: "state empty", role: "status" }, icon(iconName, "big"), el("h3", {}, title), text ? el("p", {}, text) : null, action ?? null);
}
export function ErrorState({ title = "Cannot load this view", text, onRetry }) {
  return el("div", { class: "state error", role: "alert" }, icon("circle-x", "big"), el("h3", {}, title), text ? el("p", {}, text) : null,
    onRetry ? el("button", { class: "btn", type: "button", onclick: onRetry }, icon("refresh-cw"), "Retry") : null);
}
export function Skeleton(rows = 3) {
  return el("div", { class: "skeleton", "aria-busy": "true", "aria-label": "Loading" }, Array.from({ length: rows }, () => el("div", { class: "sk-row" })));
}

export function Button({ label, iconName, onclick, variant = "", title, disabled }) {
  return el("button", { class: `btn ${variant}`.trim(), type: "button", onclick, ...(title ? { title } : {}), ...(disabled ? { disabled: true } : {}) }, iconName ? icon(iconName) : null, label);
}

/** Copies text to the clipboard and tells the user, in the live region, what happened. */
export function CopyButton(getText, label = "Copy") {
  const b = Button({ label, iconName: "copy", variant: "ghost", onclick: async () => {
    try { await navigator.clipboard.writeText(await getText()); toast("Copied to clipboard"); } catch { toast("Copy was blocked by the browser", "bad"); }
  } });
  return b;
}

let toastHost;
export function toast(message, tone = "ok") {
  toastHost ??= document.getElementById("toasts");
  const t = el("div", { class: `toast ${tone}`, role: "status" }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), 3500);
}

export const docsLink = (path, text = "Documentation") => el("a", { class: "doc-link", href: `/docs/${path}`, target: "_blank", rel: "noopener" }, icon("book-open"), text);

/** Compact key/value list. */
export function KeyValues(pairs) {
  return el("dl", { class: "kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? "-")]));
}

/**
 * Table with pagination so large workspaces stay responsive (only one page of rows is ever in the DOM).
 * columns: [{ key, label, render?(row), sort?(a,b), mono?, cls? }]
 */
export function DataTable({ caption, columns, rows, pageSize = 25, onRowClick, rowLabel, empty }) {
  let page = 0, sortKey = null, dir = 1;
  const wrap = el("div", { class: "table-wrap" });
  const draw = () => {
    let data = rows;
    if (sortKey) { const c = columns.find((x) => x.key === sortKey); data = [...rows].sort((a, b) => dir * (c.sort ? c.sort(a, b) : String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? "")))); }
    const pages = Math.max(1, Math.ceil(data.length / pageSize));
    page = Math.min(page, pages - 1);
    const slice = data.slice(page * pageSize, page * pageSize + pageSize);
    const head = el("tr", {}, columns.map((c) => {
      const th = el("th", { scope: "col", ...(sortKey === c.key ? { "aria-sort": dir === 1 ? "ascending" : "descending" } : {}) });
      th.append(c.sortable === false ? c.label : el("button", { class: "th-btn", type: "button", onclick: () => { if (sortKey === c.key) dir = -dir; else { sortKey = c.key; dir = 1; } draw(); } }, c.label, sortKey === c.key ? icon(dir === 1 ? "arrow-up" : "arrow-down") : null));
      return th;
    }));
    const body = slice.map((r) => {
      const tr = el("tr", { ...(onRowClick ? { class: "clickable" } : {}) },
        columns.map((c, i) => {
          const content = c.render ? c.render(r) : r[c.key];
          const td = el("td", { class: `${c.mono ? "mono" : ""} ${c.cls ?? ""}`.trim() });
          if (onRowClick && i === 0) {
            const b = el("button", { class: "row-btn", type: "button", onclick: () => onRowClick(r) }, content ?? "-");
            // the accessible name must start with the visible text (WCAG 2.5.3 label in name)
            b.setAttribute("aria-label", `${b.textContent} - ${rowLabel ? rowLabel(r) : "open details"}`);
            td.append(b);
          }
          else td.append(content ?? "-");
          return td;
        }));
      if (onRowClick) tr.addEventListener("click", (e) => { if (!(e.target instanceof Element) || !e.target.closest("a,button")) onRowClick(r); });
      return tr;
    });
    const table = el("table", {}, caption ? el("caption", { class: "sr-only" }, caption) : null, el("thead", {}, head), el("tbody", {}, body));
    const pager = pages > 1 ? el("div", { class: "pager" },
      el("span", { class: "muted" }, `${page * pageSize + 1}-${Math.min(data.length, page * pageSize + pageSize)} of ${data.length}`),
      Button({ label: "Previous", iconName: "chevron-left", variant: "ghost", disabled: page === 0, onclick: () => { page--; draw(); } }),
      Button({ label: "Next", iconName: "chevron-right", variant: "ghost", disabled: page >= pages - 1, onclick: () => { page++; draw(); } })) : null;
    wrap.replaceChildren(...[el("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": caption ?? "Table" }, table), data.length === 0 ? (empty ?? EmptyState({ title: "Nothing matches", text: "Adjust the filters to see rows." })) : null, pager].filter(Boolean));
  };
  draw();
  return wrap;
}

/** Slide-in detail panel (a drawer, not a modal): the page behind stays usable. Esc closes it and focus returns to the opener. */
let drawerEl, drawerOpener;
export function openDrawer({ title, subtitle, body, actions }) {
  closeDrawer(false);
  drawerOpener = document.activeElement;
  drawerEl = el("aside", { class: "drawer", role: "dialog", "aria-modal": "false", "aria-label": title, tabindex: "-1" },
    el("header", { class: "drawer-head" }, el("div", {}, el("h2", {}, title), subtitle ? el("p", { class: "muted" }, subtitle) : null),
      el("div", { class: "drawer-actions" }, actions ?? null, el("button", { class: "icon-btn", type: "button", "aria-label": "Close details", onclick: () => closeDrawer(true) }, icon("x")))),
    el("div", { class: "drawer-body" }, body));
  drawerEl.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeDrawer(true); } });
  document.getElementById("drawer-host").append(drawerEl);
  drawerEl.focus();
  return drawerEl;
}
export function closeDrawer(restoreFocus = true) {
  drawerEl?.remove(); drawerEl = undefined;
  if (restoreFocus && drawerOpener instanceof Element && "focus" in drawerOpener && document.contains(drawerOpener)) drawerOpener.focus();
  drawerOpener = undefined;
}

/** Filter bar helpers return controls plus a getter, so views keep their own state. */
export function SelectFilter({ label, options, value, onchange }) {
  const s = el("select", { "aria-label": label, onchange: () => onchange(s.value) }, options.map(([v, t]) => { const o = el("option", { value: v }, t); if (v === value) o.selected = true; return o; }));
  return el("label", { class: "field" }, el("span", {}, label), s);
}
export function SearchField({ label, value = "", placeholder, onchange }) {
  let timer;
  const i = el("input", { type: "search", "aria-label": label, placeholder: placeholder ?? label, value, autocomplete: "off", spellcheck: "false", oninput: () => { clearTimeout(timer); timer = setTimeout(() => onchange(i.value), 160); } });
  return el("label", { class: "field grow" }, icon("search"), i);
}

export const fmtTime = (iso) => { if (!iso) return "-"; const d = new Date(iso); return Number.isNaN(+d) ? "-" : d.toLocaleTimeString(); };
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
