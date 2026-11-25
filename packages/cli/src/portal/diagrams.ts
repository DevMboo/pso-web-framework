/**
 * Architecture diagrams. They are generated from data that describes what the code really does (the runtime pipeline is
 * the one implemented in @pso/http, discovery is the one implemented in @pso/core), and every node carries its responsibility,
 * so the diagram teaches instead of decorating. SVG uses CSS classes (no inline styles) and is keyboard-operable with JS,
 * while the full explanation is always present as a list below the figure (works without JS).
 */
export interface DiagramNode { label: string; sub?: string; detail: string; group?: "client" | "core" | "service" | "optional" }
export interface DiagramDef { id: string; title: string; summary: string; kind: "flow" | "fan"; nodes: DiagramNode[]; note?: string }

export const DIAGRAMS: Record<string, DiagramDef> = {
  discovery: {
    id: "discovery", title: "Structural discovery", kind: "flow",
    summary: "From files on disk to a running, validated application. Nothing in the first four steps executes application code.",
    nodes: [
      { label: "Project structure", sub: "directories + file names", detail: "The layout is the declaration: src/modules/<module>/ holds MODULE.pso.ts, routes/ROUTES.pso.ts and controllers/; src/.app/ the application-wide components; suffixes such as .guard.ts or Controller.java name the kind of a file.", group: "client" },
      { label: "PSO discovery", sub: "static, sorted, no execution", detail: "@pso/core walks the tree in byte-wise sorted order and classifies files by name and location. Application modules are never imported, so discovery is safe to run on untrusted code and gives identical results on every machine.", group: "core" },
      { label: "Contract validation", sub: "pso validate", detail: "Naming, duplicates, workspace schema (ports, dependency cycles), JSON contracts and the three-way module/route/controller check run on the TypeScript AST. Errors carry stable codes such as PSO_ROUTE_004.", group: "core" },
      { label: "Manifest generation", sub: "deterministic digest", detail: "The resource list is written as .pso/manifest.json with a sha256 digest. There are no timestamps or absolute paths, so identical inputs always produce an identical manifest.", group: "core" },
      { label: "Runtime composition", sub: "bootstrap() validates again", detail: "At start-up the orchestrator loads MODULE.pso and ROUTES.pso, builds the same neutral model from decorator metadata and runs the same validator. Dependency injection wires only providers the module declares. Any error aborts start-up; no route is activated.", group: "service" },
      { label: "Application ready", sub: "only declared routes exist", detail: "The server listens and serves exactly the validated routes plus the framework health endpoints. Everything else answers 404.", group: "service" },
    ],
  },
  lifecycle: {
    id: "lifecycle", title: "HTTP request lifecycle", kind: "flow",
    summary: "The order in which the PSO orchestrator runtime handles a request, as implemented in @pso/http.",
    nodes: [
      { label: "HTTP request", sub: "arrives at the orchestrator", detail: "The runtime assigns a server-side correlation id (a client-supplied x-correlation-id is never trusted) and starts structured logging for the request.", group: "client" },
      { label: "Rate limit", sub: "per client address", detail: "A bounded token bucket keyed by the socket address (X-Forwarded-For is not trusted). Excess requests get 429 with Retry-After. Health probes are exempt. This is one protection layer, not DDoS protection.", group: "core" },
      { label: "Route registry", sub: "ROUTES.pso.ts", detail: "The request is matched by method and path against the validated routes only. An undeclared path, or a decorated method that is not in ROUTES.pso.ts, answers 404.", group: "core" },
      { label: "Authentication", sub: "guard: jwt", detail: "The guard named by the route verifies the bearer token: asymmetric signature, issuer, audience, expiry, not-before and subject. With no key configured it denies everything. Failure answers 401.", group: "core" },
      { label: "Authorization", sub: "scopes", detail: "The same guard checks the scopes required by the route. A valid token without the required scope answers 403.", group: "core" },
      { label: "Middleware", sub: "named, per route", detail: "Middleware listed on the route runs after the guards, so it only ever sees authenticated requests (public routes excepted). A middleware may end the response.", group: "core" },
      { label: "Body and parameters", sub: "@Param @Query @Body", detail: "Path and query parameters are read and, when the action declares @Body(), the JSON body is parsed with a size limit (400 invalid JSON, 413 too large, 415 wrong content type). Schema validation of DTOs is not built in.", group: "service" },
      { label: "Controller", sub: "the action", detail: "The decorated action runs. It stays thin: it delegates to a service or forwards to an upstream service with the injected Upstream provider.", group: "service" },
      { label: "Service", sub: "provider", detail: "Providers declared in MODULE.pso.ts hold the logic that belongs to the orchestrator. Domain logic belongs in the microservices.", group: "service" },
      { label: "Response", sub: "JSON + correlation id", detail: "The returned value is serialized as JSON (201 for POST, otherwise 200). Errors never leak internals: exception filters can handle them, otherwise a generic 500 is returned.", group: "client" },
    ],
  },
  distributed: {
    id: "distributed", title: "Distributed communication", kind: "fan",
    summary: "One public entry point. Services are declared, never discovered by scanning, and discovery never grants authorization.",
    nodes: [
      { label: "Client", sub: "browser, app, API consumer", detail: "Talks only to the orchestrator. Services are not published outside the private network.", group: "client" },
      { label: "PSO orchestrator", sub: "Node.js + TypeScript", detail: "Validates tokens, applies route policy, then forwards the request with hygienic headers (spoofed x-pso-* headers dropped, Authorization forwarded only on guarded routes, timeouts and body limits).", group: "core" },
      { label: "Users service", sub: "Spring Boot", detail: "Example service. It validates the JWT itself, so bypassing the orchestrator gains nothing, and enforces scopes with method security.", group: "service" },
      { label: "Orders service", sub: "Spring Boot", detail: "Example service with its own database; services never share a database by default. Declared in pso.workspace.json with a port and dependencies.", group: "service" },
      { label: "Notifications service", sub: "Spring Boot", detail: "Example consumer. Event-driven delivery between services is part of the optional dispatch subsystem (Redis Streams, RabbitMQ or Kafka), installed with `pso dispatch:install`.", group: "optional" },
    ],
    note: "The service names are an example workspace. A real workspace contains the services declared in pso.workspace.json.",
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderDiagram(name: string): string {
  const d = DIAGRAMS[name];
  if (!d) throw new Error(`unknown diagram "${name}"`);
  const W = d.kind === "flow" ? 340 : 560, NW = 280, NH = 54, GAP = 28;
  const parts: string[] = [];
  let height: number;
  const node = (i: number, x: number, y: number, w: number) => {
    const n = d.nodes[i]!;
    return `<g class="dg-node dg-${n.group ?? "core"}" role="button" tabindex="0" data-node="${i}"><rect x="${x}" y="${y}" width="${w}" height="${NH}" rx="10"/><text class="dg-label" x="${x + w / 2}" y="${y + (n.sub ? 23 : 32)}" text-anchor="middle">${esc(n.label)}</text>${n.sub ? `<text class="dg-sub" x="${x + w / 2}" y="${y + 41}" text-anchor="middle">${esc(n.sub)}</text>` : ""}</g>`;
  };
  if (d.kind === "flow") {
    d.nodes.forEach((_, i) => {
      const y = 8 + i * (NH + GAP), x = (W - NW) / 2;
      if (i > 0) parts.push(`<path class="dg-edge" d="M${W / 2} ${y - GAP + 3} L${W / 2} ${y - 4}" marker-end="url(#dg-arrow-${d.id})"/>`);
      parts.push(node(i, x, y, NW));
    });
    height = 8 + d.nodes.length * (NH + GAP);
  } else {
    const cw = 150, gap = 20, left = (W - (3 * cw + 2 * gap)) / 2;
    parts.push(node(0, (W - NW) / 2, 8, NW), `<path class="dg-edge" d="M${W / 2} ${8 + NH + 2} L${W / 2} ${8 + NH + GAP - 4}" marker-end="url(#dg-arrow-${d.id})"/>`);
    parts.push(node(1, (W - NW) / 2, 8 + NH + GAP, NW));
    const sy = 8 + 2 * (NH + GAP) + 18;
    for (let k = 0; k < 3; k++) {
      const x = left + k * (cw + gap);
      parts.push(`<path class="dg-edge${k === 2 ? " dg-dashed" : ""}" d="M${W / 2} ${8 + NH + GAP + NH + 2} C ${W / 2} ${sy - 14}, ${x + cw / 2} ${sy - 30}, ${x + cw / 2} ${sy - 4}" marker-end="url(#dg-arrow-${d.id})"/>`);
      parts.push(node(2 + k, x, sy, cw));
    }
    height = sy + NH + 8;
  }
  const marker = `<marker id="dg-arrow-${d.id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-arrowhead" d="M0 0 L10 5 L0 10 z"/></marker>`;
  const steps = d.nodes.map((n, i) => `<li data-step="${i}"><strong>${esc(n.label)}</strong>${n.group === "optional" ? ` <span class="badge badge-planned">optional / not implemented</span>` : ""}<span>${esc(n.detail)}</span></li>`).join("");
  return `<figure class="diagram" data-diagram="${d.id}"><figcaption><strong>${esc(d.title)}</strong> <span>${esc(d.summary)}</span></figcaption><div class="diagram-body"><svg class="dg" viewBox="0 0 ${W} ${height}" role="group" aria-labelledby="dg-t-${d.id}" aria-describedby="dg-d-${d.id}"><title id="dg-t-${d.id}">${esc(d.title)}</title><desc id="dg-d-${d.id}">${esc(d.summary)} ${esc(d.nodes.map((n) => n.label).join(", then "))}.</desc><defs>${marker}</defs>${parts.join("")}</svg><ol class="diagram-steps">${steps}</ol></div>${d.note ? `<p class="diagram-note">${esc(d.note)}</p>` : ""}</figure>`;
}
