/**
 * The nginx configuration of a frontend site root, as one pure function used by BOTH `pso frontend:nginx` (a preview) and the managed
 * nginx adapter of the runtime agent (the real thing), so what is previewed is what is deployed.
 *
 * Rules the output follows (each one is checked against a real nginx in the test suite):
 *  - the shell is served under a configurable base path; paths without a file extension fall back to the shell's entry page (client
 *    routes, nested-route refresh), but a path that looks like a file (a script, a stylesheet, a map) is NEVER answered with the entry page:
 *    a missing asset is a 404;
 *  - remotes live under `/_mei/<name>/`, versioned files are immutable, the pointer and history are `no-store`;
 *  - the orchestrator is reached under one prefix (and `/channels` for WebSockets) through a loopback upstream;
 *  - the site root is read only through these locations: nothing else under it (locks, state) is reachable;
 *  - every location repeats the security headers, because nginx drops inherited `add_header` as soon as a location sets its own.
 */
export interface SiteLocationsOptions {
  /** absolute site root on the server */
  site: string;
  /** serve the shell? the base path it is built for, `/` or `/commerce/` */
  /**
   * `routes`: declared client routes whose LAST segment may look like a file (`/catalog/products/:id`, where an id can be `acme.json`).
   * `:name` matches one segment; a trailing `/*` matches anything below. They are served the entry page BEFORE the file rules apply.
   * Without them a path is a file only when its extension is a known static-asset one: dotted identifiers (`acme.corp`, `ORD-1.2.3`) are routes.
   */
  fei?: { base: string; routes?: string[] };
  /** serve remotes (always true for a site with microfrontends) */
  remotes?: boolean;
  /** the orchestrator: public prefix and the loopback port that always reaches its active release */
  api?: { path: string; port: number; channelsPath?: string };
  /** nginx variable holding the upgrade value (a `map` in the same file), when WebSockets are proxied */
  upgradeVar?: string;
  /** value of the X-PSO-Release header on the shell */
  release?: string;
  tls?: boolean;
  /** origins the browser may call besides this site (`connect-src`): the identity provider's token endpoint. https, or http on localhost only */
  connectSrc?: string[];
}

export const CONNECT_ORIGIN = /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/;

/** extensions that are ALWAYS files: a missing one is a 404, never the entry page */
export const STATIC_EXTENSIONS = "js|mjs|cjs|css|map|json|xml|svg|png|jpe?g|gif|ico|webp|avif|bmp|woff2?|ttf|otf|eot|txt|webmanifest|wasm|html?|pdf|zip|gz|mp[34]|webm|csv";
export const ROUTE_PATTERN = /^\/(?:(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*(?:\/\*)?)?$/;
const routeRegex = (p: string): string => {
  const wild = p.endsWith("/*"), segs = (wild ? p.slice(0, -2) : p).split("/").filter(Boolean);
  const body = segs.map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.]/g, "\\."))).join("/");
  return `/${body}${wild ? "(?:/.*)?" : "/?"}`;
};
export const SITE_PATH = /^\/[A-Za-z0-9_.\/-]{1,200}$/;
const NO_PARENT = (p: string): boolean => !p.split("/").includes("..") && !p.includes("//");

export function validateSiteOptions(o: SiteLocationsOptions): string[] {
  const out: string[] = [];
  if (!SITE_PATH.test(o.site) || !NO_PARENT(o.site)) out.push(`site root "${o.site}" must be an absolute plain path`);
  if (o.fei) {
    if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(o.fei.base)) out.push(`base path "${o.fei.base}" must be absolute and end with "/"`);
    if (/^\/(_mei|api|channels|_pso|_fei|health)\//.test(o.fei.base)) out.push(`base path "${o.fei.base}" overlaps a reserved prefix`);
    for (const r of o.fei.routes ?? []) if (!ROUTE_PATTERN.test(r) || r.split("/").includes("..")) out.push(`declared route "${r}" must be an absolute path of plain segments, ":param" segments and an optional trailing "/*"`);
  }
  if (o.api) {
    if (!/^\/[A-Za-z0-9._~-]+$/.test(o.api.path) || ["/_mei", "/_pso", "/_fei"].includes(o.api.path)) out.push(`api path "${o.api.path}" must be one plain segment that is not reserved`);
    if (o.fei && o.fei.base !== "/" && o.fei.base.startsWith(`${o.api.path}/`)) out.push(`the shell's base path ${o.fei.base} is inside the API prefix ${o.api.path}`);
    if (!Number.isInteger(o.api.port) || o.api.port < 1024 || o.api.port > 65535) out.push("api port must be 1024-65535");
    if (o.api.channelsPath !== undefined && !/^\/[A-Za-z0-9._~-]+$/.test(o.api.channelsPath)) out.push(`channels path "${o.api.channelsPath}" must be one plain segment`);
  }
  for (const c of o.connectSrc ?? []) if (!CONNECT_ORIGIN.test(c)) out.push(`connect-src origin "${c}" must be https://host[:port] (http only for localhost)`);
  if (o.release !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(o.release)) out.push("release id contains characters that are not allowed in a header");
  return out;
}

export function securityHeaders(tls: boolean | undefined, indent: string, connectSrc: readonly string[] = []): string[] {
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'${connectSrc.length ? " " + connectSrc.join(" ") : ""}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
  return [
    `${indent}add_header X-Content-Type-Options "nosniff" always;`,
    `${indent}add_header Referrer-Policy "no-referrer" always;`,
    `${indent}add_header X-Frame-Options "DENY" always;`,
    `${indent}add_header Content-Security-Policy "${csp}" always;`,
    ...(tls ? [`${indent}add_header Strict-Transport-Security "max-age=31536000" always;`] : []),
  ];
}

const IMMUTABLE = `add_header Cache-Control "public, max-age=31536000, immutable" always;`;
const NOSTORE = `add_header Cache-Control "no-store" always;`;
const NOCACHE = `add_header Cache-Control "no-cache" always;`;

/** Compression for the text a frontend serves (inside a `server` block). */
export function gzipDirectives(indent: string): string[] {
  return [`${indent}gzip on;`, `${indent}gzip_vary on;`, `${indent}gzip_min_length 256;`, `${indent}gzip_comp_level 5;`, `${indent}gzip_types text/css text/javascript application/javascript application/json image/svg+xml;`];
}

/** The `location` blocks of a site. Throws when an option would produce an unsafe or ambiguous file. */
export function renderSiteLocations(o: SiteLocationsOptions, indent = "    "): string[] {
  const problems = validateSiteOptions(o);
  if (problems.length) throw new Error(`invalid site configuration: ${problems.join("; ")}`);
  const i1 = indent + "    ", site = o.site.replace(/\/+$/, "");
  const H = (ind: string): string[] => securityHeaders(o.tls, ind, o.connectSrc);
  const out: string[] = [];
  const loc = (head: string, body: string[]): void => { out.push(`${indent}${head} {`, ...body.map((l) => (l.startsWith(indent) ? l : `${i1}${l}`)), `${indent}}`); };

  if (o.fei) {
    const b0 = o.fei.base === "/" ? "" : o.fei.base.replace(/\/$/, "");
    loc(`location = ${b0}/pso-runtime-config.json`, [`alias ${site}/pso-runtime-config.json;`, NOSTORE, ...H(i1)]);
  }
  if (o.remotes !== false) {
    // /_mei/<name>/v/<version>/... immutable; the pointer and the history are never cached
    out.push(`${indent}location ^~ /_mei/ {`, `${i1}root ${site};`, `${i1}${IMMUTABLE}`, ...H(i1), `${i1}try_files $uri =404;`,
      `${i1}location ~ "/(?:active|history)\\.json$" {`, `${i1}    root ${site};`, `${i1}    ${NOSTORE}`, ...H(i1 + "    "), `${i1}    try_files $uri =404;`, `${i1}}`, `${indent}}`);
  }
  if (o.api) {
    const ws = o.upgradeVar;
    const common = (target: string): string[] => [
      `proxy_pass http://127.0.0.1:${o.api!.port}${target};`, `proxy_http_version 1.1;`,
      `proxy_set_header Host $host;`, `proxy_set_header X-Real-IP $remote_addr;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `proxy_set_header X-Forwarded-Proto $scheme;`,
      ...(ws ? [`proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection ${ws};`] : [`proxy_set_header Connection "";`]),
      `proxy_connect_timeout 3s;`, `proxy_read_timeout 120s;`, `proxy_next_upstream error timeout http_502 http_503;`,
    ];
    // the trailing slash of proxy_pass strips the prefix: /api/customers reaches the orchestrator as /customers
    loc(`location ^~ ${o.api.path}/`, common("/"));
    loc(`location = ${o.api.channelsPath ?? "/channels"}`, common(`${o.api.channelsPath ?? "/channels"}`));
  }
  if (o.fei) {
    const base = o.fei.base, b0 = base === "/" ? "" : base.replace(/\/$/, ""), cur = `${site}/fei/current`;
    const rel = o.release ? [`add_header X-PSO-Release "${o.release}" always;`] : [];
    // hashed assets of EVERY retained shell release come from one content-addressed pool: a tab still running the previous shell keeps its chunks.
    // They are immutable, and a missing one is a 404 (never the entry page)
    loc(`location ^~ ${base}assets/`, [`alias ${site}/fei/assets/;`, IMMUTABLE, ...rel, ...H(i1), `try_files $uri =404;`]);
    // declared client routes win over the file rules: an identifier such as `acme.json` is a route when the application says so
    const spa = [`root ${cur};`, `rewrite ^ /index.html break;`, NOCACHE, ...rel, ...H(i1)];
    for (const r of o.fei.routes ?? []) loc(`location ~ "^${b0}${routeRegex(r)}$"`, spa);
    // a path is a FILE when its extension is a known static-asset one: served from the shell release if it exists, otherwise 404 (never the entry page)
    loc(`location ~* "^${b0}/([^/]+\\.(?:${STATIC_EXTENSIONS}))$"`, [`alias ${cur}/$1;`, NOCACHE, ...rel, ...H(i1)]);
    loc(`location ~* "^${b0}/.+\\.(?:${STATIC_EXTENSIONS})$"`, [`return 404;`]);
    // any other dotted last segment (`acme.corp`, `ORD-1.2.3`) is an application identifier and falls through to the client router
    // client routes: everything else under the base path is the entry page (refresh on a nested route)
    loc(`location ${base}`, spa);
    if (b0) loc(`location = ${b0}`, [`return 301 ${base};`]);
  }
  return out;
}

/** A complete, reviewable server block for a site (the preview of `pso frontend:nginx`). */
export function renderSiteServer(o: SiteLocationsOptions & { server?: string; listen?: number }): string {
  const up = o.upgradeVar ?? "$connection_upgrade";
  const lines = [
    `# Same-origin layout for a PSO frontend site root. The managed adapter of the runtime agent generates the same locations.`,
    `map $http_upgrade ${up} { default upgrade; '' close; }`, ``,
    `server {`, `    listen ${o.listen ?? 80};`, `    server_name ${o.server ?? "_"};`, `    server_tokens off;`, ...gzipDirectives("    "),
    ...renderSiteLocations({ ...o, upgradeVar: up }, "    "), `}`, ``,
  ];
  return lines.join("\n");
}
