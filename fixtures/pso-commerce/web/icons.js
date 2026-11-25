// Stroke icons (24x24), built with DOM calls only.
const P = {
  dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  box: "M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8",
  receipt: "M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z M9 8h6 M9 12h6",
  send: "M22 2L11 13 M22 2l-7 20-4-9-9-4z",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  radio: "M4.9 19.1a10 10 0 0 1 0-14.2 M7.8 16.2a6 6 0 0 1 0-8.4 M16.2 7.8a6 6 0 0 1 0 8.4 M19.1 4.9a10 10 0 0 1 0 14.2 M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  key: "M21 2l-2 2 M15.5 7.5l3 3L22 7l-3-3 M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z M15.5 7.5l-4 4",
  x: "M18 6L6 18 M6 6l12 12",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  play: "M5 3l14 9-14 9z",
  stop: "M6 6h12v12H6z",
  check: "M20 6L9 17l-5-5",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",
  refresh: "M23 4v6h-6 M1 20v-6h6 M3.5 9a9 9 0 0 1 15-3.4L23 10 M1 14l4.5 4.4A9 9 0 0 0 20.5 15",
  server: "M2 3h20v8H2z M2 13h20v8H2z M6 7h.01 M6 17h.01",
  trash: "M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01",
};
const NS = "http://www.w3.org/2000/svg";
export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("icon");
  const path = document.createElementNS(NS, "path"); path.setAttribute("d", P[name] ?? P.info); svg.appendChild(path);
  return svg;
}
