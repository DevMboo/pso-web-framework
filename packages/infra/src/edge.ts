import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InfraError } from "./contract.ts";

/**
 * The edge gateway's own runtime: a framework-owned image (nginx with headers-more) that carries the native error responses. Its
 * resources belong to this package (edge/: Dockerfile, main nginx configuration, page template) and are resolved next to the module, like
 * the Studio's assets, so an installation can be moved and no absolute path is ever written into a workspace. The error pages, the API
 * problem documents and the nginx snippets that serve them are generated from the status table below into a temporary build context and
 * exist only inside the image: never in a workspace, a FEI, a MEI or .infra/. The generated edge configuration only names them.
 */
export const EDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "edge");
export const EDGE_RESOURCES = ["Dockerfile", "nginx.conf", "page.html"] as const;
export const EDGE_REPOSITORY = "pso-edge";

/** Where the image keeps the error machinery. The URI prefix is internal (an external request for it is answered 404). */
export const EDGE_ERROR_URI = "/__edge_error__";
export const EDGE_INCLUDES = { locations: "/etc/nginx/edge/error-locations.conf", browser: "/etc/nginx/edge/browser-errors.conf", api: "/etc/nginx/edge/api-errors.conf" } as const;
const IMAGE_ERRORS_DIR = "/usr/share/edge/errors";

export interface EdgeStatus {
  code: number;
  /** RFC 9110 reason phrase: the title of the problem document (type about:blank) */
  reason: string;
  /** page heading and message for a person; detail for a program */
  title: string; message: string; detail: string;
  /** nginx-internal statuses answered with this one (the internal code is never shown) */
  from?: number[];
  retry?: boolean;
  /** a link to the site's home is pointless where the home answers the same (unknown host, plain HTTP, malformed requests) */
  home?: false;
}

/** Every status the edge itself can produce, and the native nginx statuses mapped onto them. */
export const EDGE_STATUSES: readonly EdgeStatus[] = [
  { code: 400, reason: "Bad Request", title: "Bad request", message: "The request could not be processed. Check the address and try again.", detail: "The request could not be processed.", from: [495, 496, 497], home: false },
  { code: 401, reason: "Unauthorized", title: "Sign-in required", message: "You need to sign in to access this page.", detail: "Authentication is required." },
  { code: 403, reason: "Forbidden", title: "Access denied", message: "You do not have permission to access this page.", detail: "Access to this resource is not allowed." },
  { code: 404, reason: "Not Found", title: "Page not found", message: "The page you are looking for does not exist or is no longer available.", detail: "No resource matches the request." },
  { code: 405, reason: "Method Not Allowed", title: "Action not allowed", message: "This action is not available for this address.", detail: "The method is not allowed for this resource." },
  { code: 408, reason: "Request Timeout", title: "Request timed out", message: "The request took too long to arrive. Please try again.", detail: "The request was not received in time.", retry: true },
  { code: 411, reason: "Length Required", title: "Bad request", message: "The request could not be processed.", detail: "The request must declare its length.", home: false },
  { code: 413, reason: "Content Too Large", title: "Content too large", message: "The content you sent is larger than allowed.", detail: "The request body is larger than allowed." },
  { code: 414, reason: "URI Too Long", title: "Address too long", message: "The address of this request is too long.", detail: "The request URI is too long.", home: false },
  { code: 416, reason: "Range Not Satisfiable", title: "Range not available", message: "The requested part of this resource is not available.", detail: "The requested range is not available." },
  { code: 421, reason: "Misdirected Request", title: "Site not available", message: "This address is not served here.", detail: "This host is not served here.", home: false },
  { code: 429, reason: "Too Many Requests", title: "Too many requests", message: "You have sent too many requests. Please wait a moment and try again.", detail: "Too many requests; retry later.", retry: true },
  { code: 431, reason: "Request Header Fields Too Large", title: "Request too large", message: "The request headers are too large. Clearing this site's cookies may help.", detail: "The request headers are too large.", from: [494], home: false },
  { code: 500, reason: "Internal Server Error", title: "Something went wrong", message: "An unexpected error occurred. Please try again later.", detail: "The request could not be completed.", retry: true },
  { code: 501, reason: "Not Implemented", title: "Not supported", message: "This request is not supported.", detail: "The request method is not supported." },
  { code: 502, reason: "Bad Gateway", title: "Service unavailable", message: "The service is temporarily unavailable. Please try again in a few moments.", detail: "The service is temporarily unavailable.", retry: true },
  { code: 503, reason: "Service Unavailable", title: "Service unavailable", message: "The service is temporarily unavailable. Please try again in a few moments.", detail: "The service is temporarily unavailable.", retry: true },
  { code: 504, reason: "Gateway Timeout", title: "Service timed out", message: "The service took too long to respond. Please try again.", detail: "The service did not respond in time.", retry: true },
  { code: 505, reason: "HTTP Version Not Supported", title: "Not supported", message: "The protocol version of this request is not supported.", detail: "The HTTP version is not supported.", home: false },
];

/** What a public error response must never contain (technology names, versions, internal names, paths, traces). Used by tests and probes. */
export const DISCLOSURE = /nginx|openresty|alpine|headers-more|node\.?js|express|spring|tomcat|keycloak|java|\bpso\b|pso[-_ ]|__edge_error__|\/usr\/|\/etc\/|\/srv\/|\/run\/|[0-9]\.[0-9]+\.[0-9]+|stack|exception|upstream|plain HTTP|HTTPS port|\b49[4-7]\b/i;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function resource(name: (typeof EDGE_RESOURCES)[number]): string {
  const f = join(EDGE_DIR, name);
  if (!existsSync(f)) throw new InfraError(`the edge resources of this PSO installation are incomplete: ${name} is missing`, "PSO_EDGE_RESOURCES_MISSING", "Repair or reinstall PSO (pso repair, or the installer). Nothing in the workspace needs to change");
  return readFileSync(f, "utf8").replace(/\r\n/g, "\n");
}

/** The browser page of one status: the one template, no script, no external resource, the same style everywhere. */
export function renderErrorPage(s: EdgeStatus, template = resource("page.html")): string {
  const links = [...(s.retry ? ['<a href="">Try again</a>'] : []), ...(s.home === false ? [] : ['<a href="/">Go to the home page</a>'])];
  const nav = links.length ? `<nav aria-label="Next steps">${links.join("")}</nav>` : "";
  const out = template.replace(/\{\{code\}\}/g, String(s.code)).replace(/\{\{title\}\}/g, esc(s.title)).replace(/\{\{message\}\}/g, esc(s.message)).replace("{{nav}}\n", nav ? `${nav}\n` : "");
  if (/\{\{[a-z]+\}\}/.test(out)) throw new InfraError("the edge page template has an unknown placeholder", "PSO_EDGE_RESOURCES_INVALID");
  return out;
}

/** The RFC 9457 document of one status for API clients. The request never reached the application, so no application code is given. */
export function renderProblem(s: EdgeStatus): string {
  return JSON.stringify({ type: "about:blank", title: s.reason, status: s.code, detail: s.detail }) + "\n";
}

/** The pages' only inline style, allowed by hash: the error responses' policy permits nothing else. */
export function pageStyleHash(template = resource("page.html")): string {
  const m = /<style>([\s\S]*?)<\/style>/.exec(template);
  if (!m) throw new InfraError("the edge page template has no style", "PSO_EDGE_RESOURCES_INVALID");
  return `sha256-${createHash("sha256").update(m[1]!).digest("base64")}`;
}

function errorPageDirectives(kind: "html" | "problem"): string {
  const file = (code: number) => `${EDGE_ERROR_URI}/${kind}/${code}.${kind === "html" ? "html" : "json"}`;
  return EDGE_STATUSES.flatMap((s) => [`error_page ${s.code} ${file(s.code)};`, ...(s.from ? [`error_page ${s.from.join(" ")} =${s.code} ${file(s.code)};`] : [])]).join("\n") + "\n";
}

function errorLocations(template: string): string {
  // a location that sets its own headers inherits none, so the response headers are complete here; `always` applies them to error statuses
  const common = (csp: string) => [
    "    internal;", "    etag off;", "    if_modified_since off;",
    "    more_clear_headers Server X-Powered-By X-AspNet-Version X-AspNetMvc-Version Last-Modified ETag Accept-Ranges;",
    '    add_header Cache-Control "no-store" always;', '    add_header X-Content-Type-Options "nosniff" always;', '    add_header X-Frame-Options "DENY" always;',
    '    add_header Referrer-Policy "no-referrer" always;', `    add_header Content-Security-Policy "${csp}" always;`, '    add_header Strict-Transport-Security "max-age=31536000" always;',
    "    add_header X-Correlation-ID $request_id always;",
  ];
  return [
    "# Native error responses of the edge (generated with the image; included in every public server block of the edge configuration).",
    `location ^~ ${EDGE_ERROR_URI}/html/ {`, `    alias ${IMAGE_ERRORS_DIR}/html/;`, "    charset utf-8;",
    ...common(`default-src 'none'; style-src '${pageStyleHash(template)}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`), "}",
    `location ^~ ${EDGE_ERROR_URI}/problem/ {`, `    alias ${IMAGE_ERRORS_DIR}/problem/;`, "    types { }", "    default_type application/problem+json;",
    ...common("default-src 'none'; frame-ancestors 'none'"), "}", "",
  ].join("\n");
}

/** Every file of the image's build context, path -> content (forward slashes). Deterministic: the same framework gives the same bytes. */
export function edgeBuildContext(): Map<string, string> {
  const template = resource("page.html");
  const files = new Map<string, string>([["Dockerfile", resource("Dockerfile")], ["nginx.conf", resource("nginx.conf")]]);
  files.set("conf/error-locations.conf", errorLocations(template));
  files.set("conf/browser-errors.conf", errorPageDirectives("html"));
  files.set("conf/api-errors.conf", errorPageDirectives("problem"));
  for (const s of EDGE_STATUSES) { files.set(`errors/html/${s.code}.html`, renderErrorPage(s, template)); files.set(`errors/problem/${s.code}.json`, renderProblem(s)); }
  return files;
}

let cached: { tag: string; files: Map<string, string> } | undefined;
/** The image a configuration rendered by this framework runs on: its tag is the SHA-256 of the build context. */
export function edgeImage(): { tag: string; files: Map<string, string> } {
  if (cached) return cached;
  const files = edgeBuildContext();
  const h = createHash("sha256");
  for (const k of [...files.keys()].sort()) h.update(k).update("\0").update(files.get(k)!).update("\0");
  cached = { tag: `${EDGE_REPOSITORY}:${h.digest("hex").slice(0, 16)}`, files };
  return cached;
}

export const edgeImagePresent = (tag: string): boolean => spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore", windowsHide: true, timeout: 30_000 }).status === 0;

/**
 * Makes sure the edge image a compose file names exists locally; builds it from this installation when it does not. A tag of another
 * framework build cannot be produced here: the configuration must be regenerated by this release first.
 */
export async function ensureEdgeImage(tag: string, log: (l: string) => void = () => {}): Promise<"present" | "built"> {
  if (edgeImagePresent(tag)) return "present";
  const own = edgeImage();
  if (tag !== own.tag) throw new InfraError(`the configuration names the edge image ${tag}, which this PSO release does not build (it builds ${own.tag})`, "PSO_EDGE_IMAGE_FOREIGN", "Regenerate the configuration with this release: pso infra:apply");
  const ctx = mkdtempSync(join(tmpdir(), "pso-edge-"));
  try {
    for (const [p, content] of own.files) { const f = join(ctx, ...p.split("/")); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); }
    log(`building the edge image ${tag} (once per PSO release) ...`);
    const code = await new Promise<number>((resolve) => {
      const p = spawn("docker", ["build", "--label", "org.opencontainers.image.title=edge", "-t", tag, ctx], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let buf = "";
      const on = (d: Buffer) => { buf += d.toString(); const ls = buf.split(/\r?\n/); buf = ls.pop() ?? ""; for (const l of ls) if (l.trim()) log(`  ${l}`); };
      p.stdout.on("data", on); p.stderr.on("data", on);
      p.on("error", () => resolve(127)); p.on("exit", (c) => { if (buf.trim()) log(`  ${buf}`); resolve(c ?? 1); });
    });
    if (code !== 0) throw new InfraError(`the edge image could not be built (docker build exit ${code})`, "PSO_EDGE_IMAGE_BUILD", "The build output is above. It needs the base image and Alpine's package repository once (network access)");
    return "built";
  } finally { rmSync(ctx, { recursive: true, force: true }); }
}
