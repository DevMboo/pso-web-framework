// Small DOM helpers. Text is ALWAYS set with textContent / createTextNode: nothing received from the network is ever parsed as HTML.
import { icon } from "./icons.js";
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(n.dataset, v); else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
export const withIcon = (name, label, size = 16) => el("span", { class: "with-icon" }, icon(name, size), el("span", { text: label }));
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export const fmtTime = (d = new Date()) => d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
export const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
export function statusClass(s) { return s >= 500 ? "bad" : s >= 400 ? "warn" : s >= 200 ? "ok" : "muted"; }
export function pretty(text) { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }
export function copyText(text) { return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("clipboard unavailable")); }
export function toast(message, kind = "info") {
  const host = $("#toasts"); const t = el("div", { class: `toast ${kind}`, role: "status" }, icon(kind === "bad" ? "alert" : kind === "ok" ? "check" : "info", 16), el("span", { text: message }));
  host.append(t); setTimeout(() => t.remove(), 5000);
}
