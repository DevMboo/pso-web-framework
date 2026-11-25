import {
  BUILTIN_MIDDLEWARES, CONTEXT_CONTRACT_VERSION, DEFAULT_FEI_PORT, DEFAULT_MEI_PORT, RESERVED_PATH_PREFIXES,
  type FeiDefinition, type FrontendRoute, type FrontendRoutesDefinition, type MeiDefinition,
} from "./contracts.ts";

/** Same shape as `Diagnostic` of @pso/core, so the CLI prints both alike. */
export interface FrontendDiagnostic { code: string; severity: "error" | "warning" | "info"; message: string; file?: string; hint?: string }
const d = (severity: FrontendDiagnostic["severity"], code: string, message: string, file?: string, hint?: string): FrontendDiagnostic => ({ code, severity, message, ...(file ? { file } : {}), ...(hint ? { hint } : {}) });

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCOPE = /^[A-Za-z0-9._:-]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A URL path owned by the application: `/customers`, `/customers/new`. No query, no dots segments, no scheme, no `//`. */
export function isSafeAppPath(p: unknown): p is string {
  return typeof p === "string" && /^\/[A-Za-z0-9._~\-/:*%]*$/.test(p) && !p.includes("//") && !p.split("/").some((s) => s === "." || s === "..") && !p.includes("%2e") && !p.includes("%2E") && !p.includes("%2f") && !p.includes("%2F");
}
/** A redirect target is accepted only when it stays inside this origin: an absolute path, never `//host`, `/\host` or a scheme. */
export function isSafeRedirect(to: unknown): to is string {
  return typeof to === "string" && to.length < 2048 && /^\/(?![/\\])/.test(to) && !/[\u0000-\u001f\\]/.test(to);
}

/** Pages the shell serves itself, whatever is declared: the OIDC return address and the access-denied page. */
export const SHELL_PATHS = ["/auth/callback", "/forbidden"] as const;

const reserved = (p: string): string | undefined => RESERVED_PATH_PREFIXES.find((r) => p === r || p.startsWith(`${r}/`));
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function validPort(v: unknown): boolean { return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535; }

export function validateFei(raw: unknown, file = "FEI.pso.ts"): FrontendDiagnostic[] {
  const out: FrontendDiagnostic[] = [];
  const err = (c: string, m: string, h?: string) => out.push(d("error", c, m, file, h));
  if (!isObj(raw)) return [d("error", "PSO_FEI_SHAPE", "the FEI declaration must be an object: export default defineFEI({ ... })", file)];
  const f = raw as unknown as Partial<FeiDefinition> & Record<string, unknown>;
  if (typeof f.name !== "string" || !KEBAB.test(f.name) || !f.name.startsWith("fei-")) err("PSO_FEI_NAME", `"name" must be kebab-case and start with "fei-" (got ${JSON.stringify(f.name)})`, `Example: "fei-commerce"`);
  if (f.server !== undefined && (!isObj(f.server) || (f.server.port !== undefined && !validPort(f.server.port)))) err("PSO_FEI_PORT", `"server.port" must be an integer between 1024 and 65535`);
  if (!isObj(f.orchestrator) || typeof f.orchestrator.service !== "string" || !KEBAB.test(f.orchestrator.service)) err("PSO_FEI_ORCHESTRATOR", `"orchestrator.service" must name the PSO orchestrator of the workspace (kebab-case)`, "The frontend talks only to the orchestrator");
  else if (f.orchestrator.basePath !== undefined && (!isSafeAppPath(f.orchestrator.basePath) || f.orchestrator.basePath === "/")) err("PSO_FEI_BASEPATH", `"orchestrator.basePath" must be a same-origin path such as "/api"`, "The API client never accepts an absolute URL");
  const sec = isObj(f.security) ? f.security : {};
  if (f.security !== undefined && !isObj(f.security)) err("PSO_FEI_SECURITY", `"security" must be an object`);
  if (sec["authentication"] !== undefined && sec["authentication"] !== "jwt" && sec["authentication"] !== "none") err("PSO_FEI_AUTH", `"security.authentication" must be "jwt" or "none"`);
  if (sec["session"] !== undefined && sec["session"] !== "centralized" && sec["session"] !== "none") err("PSO_FEI_SESSION", `"security.session" must be "centralized" or "none"`);
  if (sec["loginPath"] !== undefined && !(isSafeAppPath(sec["loginPath"]))) err("PSO_FEI_LOGIN_PATH", `"security.loginPath" must be a path inside this application`, "Open redirects are refused");
  const authOn = (sec["authentication"] ?? "jwt") === "jwt";
  // contradictory security: without authentication there is no session, so nothing can be gated by a scope and nothing needs to be "public"
  if (!authOn && Array.isArray(f.microfrontends)) {
    (f.microfrontends as unknown as Array<Record<string, unknown>>).forEach((m, i) => {
      if (Array.isArray(m?.["scopes"]) && (m["scopes"] as unknown[]).length > 0) err("PSO_FEI_AUTH_CONTRADICTION", `microfrontends[${i}] ("${String(m["name"])}") requires scopes, but security.authentication is "none": no visitor can ever have a scope`, "Enable authentication (\"jwt\") or remove the scopes");
    });
  }
  if (!authOn && sec["session"] === "centralized") err("PSO_FEI_AUTH_CONTRADICTION", `security.session is "centralized" while security.authentication is "none": there is no session to centralize`, "Set session to \"none\" or enable authentication");

  const mws = f.middlewares ?? [...BUILTIN_MIDDLEWARES];
  if (!Array.isArray(mws) || !mws.every((m) => typeof m === "string" && KEBAB.test(m))) err("PSO_FEI_MIDDLEWARES", `"middlewares" must be a list of middleware names (kebab-case)`);
  else {
    const seen = new Set<string>();
    for (const m of mws) { if (seen.has(m)) err("PSO_FEI_MIDDLEWARE_DUPLICATE", `middleware "${m}" is listed twice`); seen.add(m); }
    if (authOn) {
      const ia = mws.indexOf("authentication"), iz = mws.indexOf("authorization");
      if (ia < 0) err("PSO_FEI_MIDDLEWARE_MANDATORY", `"authentication" is mandatory while security.authentication is "jwt"`, `Add "authentication" first in "middlewares"`);
      if (iz < 0) err("PSO_FEI_MIDDLEWARE_MANDATORY", `"authorization" is mandatory while security.authentication is "jwt"`, `Add "authorization" after "authentication"`);
      if (ia >= 0 && iz >= 0 && ia > iz) err("PSO_FEI_MIDDLEWARE_ORDER", `"authentication" must run before "authorization" (it is listed after it)`);
      const first = mws.findIndex((m) => m !== "authentication");
      if (ia > 0 && first >= 0 && first < ia) err("PSO_FEI_MIDDLEWARE_ORDER", `"${mws[0]}" runs before "authentication": a custom middleware must not see an unauthenticated navigation`, `Move "authentication" to the first position`);
    }
  }

  if (!Array.isArray(f.microfrontends)) { err("PSO_FEI_MICROFRONTENDS", `"microfrontends" must be a list`); return out; }
  const names = new Map<string, number>(), paths: Array<{ name: string; path: string }> = [];
  f.microfrontends.forEach((m, i) => {
    const at = `microfrontends[${i}]`;
    if (!isObj(m)) { err("PSO_FEI_MICROFRONTEND_SHAPE", `${at} must be an object`); return; }
    const name = m["name"], path = m["path"];
    if (typeof name !== "string" || !KEBAB.test(name) || !name.startsWith("mei-")) { err("PSO_FEI_MICROFRONTEND_NAME", `${at}.name must be kebab-case and start with "mei-" (got ${JSON.stringify(name)})`); return; }
    if (names.has(name)) err("PSO_FEI_MICROFRONTEND_DUPLICATE", `${at}: microfrontend "${name}" is registered twice (also microfrontends[${names.get(name)}])`);
    names.set(name, i);
    if (!isSafeAppPath(path) || path === "/") { err("PSO_FEI_MICROFRONTEND_PATH", `${at} ("${name}"): "path" must be a path such as "/customers" (got ${JSON.stringify(path)})`); return; }
    if (/[:*]/.test(path)) err("PSO_FEI_MICROFRONTEND_PATH", `${at} ("${name}"): the mount path "${path}" cannot contain parameters: the MEI owns its inner routes`);
    if (path.endsWith("/")) err("PSO_FEI_MICROFRONTEND_PATH", `${at} ("${name}"): the mount path "${path}" must not end with "/"`);
    const r = reserved(path);
    if (r) err("PSO_FEI_ROUTE_RESERVED", `${at} ("${name}"): "${path}" is under "${r}", which belongs to the API, the remote artifacts or PSO itself`, "Choose another path: the browser-visible routes must never collide with /api or /_mei");
    for (const p of paths) if (overlaps(p.path, path)) err("PSO_FEI_ROUTE_CONFLICT", `${at}: "${name}" mounts "${path}", which overlaps "${p.name}" (${p.path}): a MEI must own a route prefix exclusively`, "Give each MEI its own, non-nested prefix");
    paths.push({ name, path });
    if (m["scopes"] !== undefined && (!Array.isArray(m["scopes"]) || !m["scopes"].every((s) => typeof s === "string" && SCOPE.test(s)))) err("PSO_FEI_MICROFRONTEND_SCOPES", `${at} ("${name}"): "scopes" must be a list of scope names`);
    if (m["loading"] !== undefined && m["loading"] !== "lazy" && m["loading"] !== "eager") err("PSO_FEI_MICROFRONTEND_LOADING", `${at} ("${name}"): "loading" must be "lazy" or "eager"`);
    // routes the shell owns: a mount that contains one would hand it to the MEI
    for (const shell of SHELL_PATHS) if (overlaps(path, shell)) err("PSO_FEI_MOUNT_SHELL_ROUTE", `${at} ("${name}"): the mount path "${path}" contains "${shell}", which the shell itself serves`, "Choose another mount path");
    const pub = m["public"];
    if (pub !== undefined) {
      const okList = Array.isArray(pub) && pub.length > 0 && pub.every((x) => typeof x === "string" && isSafeAppPath(x) && (x === "/" || !x.endsWith("/")));
      if (pub !== true && pub !== false && !okList) {
        err("PSO_FEI_MICROFRONTEND_PUBLIC", `${at} ("${name}"): "public" must be true, false or a non-empty list of paths inside the MEI such as ["/", "/login", "/guide/*"] (got ${JSON.stringify(pub)})`, "Only the listed routes are public; everything else stays protected");
      } else if (pub !== false && Array.isArray(m["scopes"]) && m["scopes"].length > 0) {
        err("PSO_FEI_MICROFRONTEND_PUBLIC_SCOPES", `${at} ("${name}"): a public microfrontend cannot require scopes (a visitor has none)`, "Remove \"scopes\", or keep the MEI protected");
      } else if (okList) {
        for (const p of pub as string[]) if (p.includes("*") && !p.endsWith("/*")) err("PSO_FEI_MICROFRONTEND_PUBLIC", `${at} ("${name}"): "*" is only allowed as the last segment of a public path (${p})`);
      }
    }
  });
  // the page a visitor is sent to when a protected route needs a session must itself be reachable without one, or the redirect never ends
  const login = typeof sec["loginPath"] === "string" ? sec["loginPath"] : "/login";
  if (authOn && isSafeAppPath(login)) {
    const mount = ownerOf(paths, login);
    if (mount) {
      const entry = (f.microfrontends as unknown as Array<Record<string, unknown>>).find((x) => x["name"] === mount.name);
      if (!entry || !isPublicMeiPath({ path: mount.path, public: entry["public"] as boolean | string[] | undefined }, login)) {
        err("PSO_FEI_LOGIN_PATH_PROTECTED", `"security.loginPath" ("${login}") is inside the mount of "${mount.name}" but is not public there: a visitor sent to sign in would be redirected to sign in again`, `Declare it public: microfrontends[].public: ["${login.slice(mount.path.length) || "/"}"]`);
      }
    }
  }
  const known = new Set<string>(BUILTIN_MIDDLEWARES);
  // custom middleware names are checked against src/middlewares by the CLI (it can see the disk)
  void known;
  return out;
}

export function validateMei(raw: unknown, file = "MEI.pso.ts"): FrontendDiagnostic[] {
  const out: FrontendDiagnostic[] = [];
  const err = (c: string, m: string, h?: string) => out.push(d("error", c, m, file, h));
  if (!isObj(raw)) return [d("error", "PSO_MEI_SHAPE", "the MEI declaration must be an object: export default defineMEI({ ... })", file)];
  const m = raw as Partial<MeiDefinition> & Record<string, unknown>;
  if (typeof m.name !== "string" || !KEBAB.test(m.name) || !m.name.startsWith("mei-")) err("PSO_MEI_NAME", `"name" must be kebab-case and start with "mei-" (got ${JSON.stringify(m.name)})`, `Example: "mei-customers"`);
  if (typeof m.host !== "string" || !KEBAB.test(m.host) || !m.host.startsWith("fei-")) err("PSO_MEI_HOST", `"host" must name the FEI this MEI is built for (kebab-case, starts with "fei-"; got ${JSON.stringify(m.host)})`);
  if (m.server !== undefined && (!isObj(m.server) || (m.server.port !== undefined && !validPort(m.server.port)))) err("PSO_MEI_PORT", `"server.port" must be an integer between 1024 and 65535`);
  if (!isObj(m.orchestrator) || typeof m.orchestrator.service !== "string" || !KEBAB.test(m.orchestrator.service)) err("PSO_MEI_ORCHESTRATOR", `"orchestrator.service" must name the PSO orchestrator (kebab-case)`, "A MEI never talks to a microservice directly");
  if (m.expose !== undefined) {
    const mod = isObj(m.expose) ? m.expose["module"] : undefined;
    if (mod !== undefined && (typeof mod !== "string" || !/^\.\/(?!.*\.\.)[A-Za-z0-9_./-]+\.(tsx|ts)$/.test(mod))) err("PSO_MEI_EXPOSE", `"expose.module" must be a project-relative .ts/.tsx path like "./src/module.tsx" (got ${JSON.stringify(mod)})`);
  }
  if (m.security !== undefined) {
    if (!isObj(m.security)) err("PSO_MEI_SECURITY", `"security" must be an object`);
    else {
      if (m.security.inheritFromHost === false) err("PSO_MEI_SESSION", `"security.inheritFromHost" cannot be false: a MEI never has its own authentication lifecycle`, "Remove it or set it to true. For standalone development the development host adapter provides the session");
      if (m.security.scopes !== undefined && (!Array.isArray(m.security.scopes) || !m.security.scopes.every((s) => typeof s === "string" && SCOPE.test(s)))) err("PSO_MEI_SCOPES", `"security.scopes" must be a list of scope names`);
    }
  }
  const c = isObj(m.contract) ? m.contract["context"] : undefined;
  if (c !== undefined && (typeof c !== "string" || !/^\d+\.\d+$/.test(c))) err("PSO_MEI_CONTRACT", `"contract.context" must be "major.minor" (got ${JSON.stringify(c)})`);
  if (m.middlewares !== undefined && (!Array.isArray(m.middlewares) || !m.middlewares.every((x) => typeof x === "string" && KEBAB.test(x)))) err("PSO_MEI_MIDDLEWARES", `"middlewares" must be a list of middleware names`);
  else if (Array.isArray(m.middlewares) && m.middlewares.some((x) => (BUILTIN_MIDDLEWARES as readonly string[]).includes(x as string))) err("PSO_MEI_MIDDLEWARE_MANDATORY", `a MEI cannot list a mandatory FEI middleware (${BUILTIN_MIDDLEWARES.join(", ")}): it cannot replace or repeat them`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// contract compatibility

export function parseContract(v: string): { major: number; minor: number } | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}
/** A MEI built for `required` runs in a host offering `offered` when the major is equal and the host's minor is at least the MEI's. */
export function contractCompatible(required: string, offered: string = CONTEXT_CONTRACT_VERSION): { ok: true } | { ok: false; reason: string } {
  const r = parseContract(required), o = parseContract(offered);
  if (!r || !o) return { ok: false, reason: `invalid contract version ("${required}" / "${offered}")` };
  if (r.major !== o.major) return { ok: false, reason: `the MEI needs context contract ${required} and the host offers ${offered}: major versions differ` };
  if (r.minor > o.minor) return { ok: false, reason: `the MEI needs context contract ${required}, newer than the host's ${offered}: update the FEI` };
  return { ok: true };
}

/** Semver-lite check of a shared dependency version against a range written as `^x.y.z`, `~x.y.z`, `>=x.y.z` or `x.y.z`. */
export function satisfies(version: string, range: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version), r = /^(\^|~|>=)?(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!v || !r) return false;
  const [vM, vm, vp] = [Number(v[1]), Number(v[2]), Number(v[3])], [rM, rm, rp] = [Number(r[2]), Number(r[3]), Number(r[4])];
  const ge = vM > rM || (vM === rM && (vm > rm || (vm === rm && vp >= rp)));
  switch (r[1]) {
    case "^": return vM === rM && ge;
    case "~": return vM === rM && vm === rm && ge;
    case ">=": return ge;
    default: return vM === rM && vm === rm && vp === rp;
  }
}

export interface MeiInfo { name: string; file: string; definition: MeiDefinition }

/** Checks every relationship between a FEI and the MEIs found in the workspace, naming the exact configuration responsible. */
export function validateRelationships(fei: { file: string; definition: FeiDefinition }, meis: MeiInfo[]): FrontendDiagnostic[] {
  const out: FrontendDiagnostic[] = [];
  const registered = new Map(fei.definition.microfrontends.map((m, i) => [m.name, { m, i }]));
  const byName = new Map(meis.map((m) => [m.name, m]));
  const ports = new Map<number, string>();
  const claim = (port: number | undefined, who: string, file: string) => {
    if (port === undefined) return;
    const other = ports.get(port);
    if (other) out.push(d("error", "PSO_FRONTEND_PORT_CONFLICT", `${who} and ${other} both use port ${port}`, file, "Give each frontend project its own development port"));
    else ports.set(port, who);
  };
  claim(fei.definition.server?.port ?? DEFAULT_FEI_PORT, fei.definition.name, fei.file);
  for (const mei of meis) {
    const def = mei.definition;
    claim(def.server?.port, def.name, mei.file);
    if (def.host !== fei.definition.name) {
      out.push(d("error", "PSO_MEI_HOST_MISMATCH", `${def.name} declares host "${def.host}" but is evaluated against FEI "${fei.definition.name}"`, mei.file, `Set "host": "${fei.definition.name}" or register the MEI with the FEI that matches`));
      continue;
    }
    const reg = registered.get(def.name);
    if (!reg) { out.push(d("error", "PSO_MEI_NOT_REGISTERED", `${def.name} declares host "${def.host}", but ${fei.file} does not register it`, mei.file, `Run: pso fei:register ${def.name.replace(/^mei-/, "")}`)); continue; }
    if (def.orchestrator.service !== fei.definition.orchestrator.service) out.push(d("error", "PSO_MEI_ORCHESTRATOR_MISMATCH", `${def.name} (${mei.file}) uses orchestrator "${def.orchestrator.service}" but its host uses "${fei.definition.orchestrator.service}": all frontends of an ecosystem share one orchestrator`, mei.file));
    const cc = contractCompatible(def.contract?.context ?? CONTEXT_CONTRACT_VERSION);
    if (!cc.ok) out.push(d("error", "PSO_MEI_CONTRACT_INCOMPATIBLE", `${def.name} (${mei.file}): ${cc.reason}`, mei.file));
    const need = reg.m.scopes ?? [], has = new Set(def.security?.scopes ?? []);
    for (const s of need) if (def.security?.scopes && !has.has(s)) out.push(d("error", "PSO_MEI_SCOPE_MISMATCH", `${fei.file} microfrontends[${reg.i}] requires scope "${s}" to enter ${def.name}, but ${def.name} does not declare it in security.scopes`, fei.file, `Add "${s}" to security.scopes of ${def.name} or remove it from the FEI entry`));
    for (const s of def.security?.scopes ?? []) if (!need.includes(s)) out.push(d("info", "PSO_MEI_SCOPE_NOT_GATED", `${def.name} uses scope "${s}" but ${fei.file} does not require it to enter "${reg.m.path}": the navigation will not hide the MEI from users without it (the orchestrator still enforces it)`, mei.file));
  }
  for (const [name, { i }] of registered) if (!byName.has(name)) out.push(d("warning", "PSO_FEI_REMOTE_NOT_FOUND", `${fei.file} microfrontends[${i}] registers "${name}", but no MEI project with that name exists in this workspace`, fei.file, "In production the remote comes from its approved manifest; in development the project must exist"));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// routes

export interface ResolvedRoute {
  /** effective, browser-visible pattern, e.g. `/customers/:id` */
  path: string;
  owner: string;
  page?: string;
  layout?: string;
  redirect?: string;
  title?: string | Record<string, string>;
  scopes: string[];
  meta: Record<string, unknown>;
  /** the chain of titles from the mount point, for breadcrumbs */
  trail: Array<{ path: string; title?: string | Record<string, string> }>;
  file: string;
}

const segs = (p: string): string[] => p.split("/").filter(Boolean);
export const joinPath = (...parts: string[]): string => "/" + parts.flatMap(segs).join("/");

export function validateRoutes(raw: unknown, file = "ROUTES.pso.ts", options: { owner?: "fei" | "mei" } = {}): FrontendDiagnostic[] {
  const out: FrontendDiagnostic[] = [];
  if (!isObj(raw) || !Array.isArray(raw["routes"])) return [d("error", "PSO_ROUTES_SHAPE", `export default defineFrontendRoutes({ routes: [...] }) is required`, file)];
  const walk = (routes: unknown[], at: string) => {
    routes.forEach((r, i) => {
      const here = `${at}[${i}]`;
      if (!isObj(r)) { out.push(d("error", "PSO_ROUTE_SHAPE", `${here} must be an object`, file)); return; }
      const path = r["path"];
      if (!isSafeAppPath(path)) { out.push(d("error", "PSO_ROUTE_PATH", `${here}: invalid path ${JSON.stringify(path)}`, file, "Use paths such as \"/\", \"/new\", \"/:id\"")); return; }
      if (path.includes("*") && !path.endsWith("/*") && path !== "*") out.push(d("error", "PSO_ROUTE_PATH", `${here}: "*" is only allowed as the last segment`, file));
      const kinds = ["page", "redirect"].filter((k) => r[k] !== undefined);
      if (kinds.length === 0 && !Array.isArray(r["children"])) out.push(d("error", "PSO_ROUTE_EMPTY", `${here} ("${path}") needs a "page", a "redirect" or "children"`, file));
      if (kinds.length === 2) out.push(d("error", "PSO_ROUTE_AMBIGUOUS", `${here} ("${path}") has both "page" and "redirect"`, file));
      for (const k of ["page", "layout"] as const) if (r[k] !== undefined && (typeof r[k] !== "string" || !/^\.\/(?!.*\.\.)[A-Za-z0-9_./\-[\]]+\.(tsx|ts|jsx|js)$/.test(r[k] as string))) out.push(d("error", "PSO_ROUTE_FILE", `${here} ("${path}"): "${k}" must be a project-relative file like "./src/pages/Home.tsx" (got ${JSON.stringify(r[k])})`, file, "No \"..\" and no absolute paths: a route can only point inside its own project"));
      if (r["redirect"] !== undefined && !isSafeAppPath(r["redirect"])) out.push(d("error", "PSO_ROUTE_REDIRECT", `${here} ("${path}"): "redirect" must be a path inside the application`, file));
      if (r["scopes"] !== undefined && (!Array.isArray(r["scopes"]) || !r["scopes"].every((s) => typeof s === "string" && SCOPE.test(s)))) out.push(d("error", "PSO_ROUTE_SCOPES", `${here} ("${path}"): "scopes" must be a list of scope names`, file));
      if (r["public"] !== undefined) {
        if (typeof r["public"] !== "boolean") out.push(d("error", "PSO_ROUTE_PUBLIC", `${here} ("${path}"): "public" must be true or false`, file));
        else if (r["public"] && options.owner === "mei") out.push(d("error", "PSO_ROUTE_PUBLIC_MEI", `${here} ("${path}"): a microfrontend cannot make its own route public`, file, "Only the FEI decides: declare it in FEI.pso.ts, microfrontends[].public"));
      }
      // one route, one access decision: the 0.1 spelling (meta.public) and the 0.2 one (public) must not disagree, and a public page cannot need scopes
      const metaPub = isObj(r["meta"]) ? r["meta"]["public"] : undefined;
      if (typeof r["public"] === "boolean" && typeof metaPub === "boolean" && r["public"] !== metaPub) out.push(d("error", "PSO_ROUTE_PUBLIC_AMBIGUOUS", `${here} ("${path}"): "public: ${String(r["public"])}" contradicts "meta.public: ${String(metaPub)}"`, file, "Keep only \"public\""));
      if ((r["public"] === true || metaPub === true) && Array.isArray(r["scopes"]) && r["scopes"].length > 0) out.push(d("error", "PSO_ROUTE_PUBLIC_SCOPES", `${here} ("${path}"): a public route cannot require scopes (a visitor has no session)`, file, "Remove \"scopes\" or make the route protected"));
      if (metaPub === true && options.owner === "mei") out.push(d("error", "PSO_ROUTE_PUBLIC_MEI", `${here} ("${path}"): a microfrontend cannot make its own route public (meta.public)`, file, "Only the FEI decides: declare it in FEI.pso.ts, microfrontends[].public"));
      if (Array.isArray(r["children"])) walk(r["children"], `${here}.children`);
    });
  };
  walk(raw["routes"], "routes");
  return out;
}

/** Flattens a route tree under `mount` into effective routes. Each route keeps its owner. */
export function flattenRoutes(def: FrontendRoutesDefinition, owner: string, mount: string, file: string): ResolvedRoute[] {
  const out: ResolvedRoute[] = [];
  const walk = (routes: FrontendRoute[], base: string, scopes: string[], trail: ResolvedRoute["trail"], layout?: string) => {
    for (const r of routes) {
      const path = joinPath(base, r.path);
      const own = [...new Set([...scopes, ...(r.scopes ?? [])])];
      const t = [...trail, { path, ...(r.title !== undefined ? { title: r.title } : {}) }];
      const lay = r.layout ?? layout;
      if (r.page !== undefined || r.redirect !== undefined) out.push({ path, owner, ...(r.page !== undefined ? { page: r.page } : {}), ...(lay !== undefined ? { layout: lay } : {}), ...(r.redirect !== undefined ? { redirect: joinPath(mount, r.redirect) } : {}), ...(r.title !== undefined ? { title: r.title } : {}), scopes: own, meta: { ...(r.meta ?? {}), ...(r.public === true ? { public: true } : {}) }, trail: t, file });
      if (r.children) walk(r.children, path, own, t, lay);
    }
  };
  walk(def.routes, mount, [], []);
  return out;
}

/** Specificity of a pattern, compared segment by segment: static beats `:param` beats `*`. */
const rank = (s: string): number => (s === "*" ? 1 : s.startsWith(":") ? 2 : 3);
export function comparePrecedence(a: string, b: string): number {
  const x = segs(a), y = segs(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!, q = y[i]!;
    const d2 = rank(q) - rank(p);
    if (d2 !== 0) return d2;
    if (rank(p) === 3 && p !== q) return p < q ? -1 : 1;
  }
  return y.length - x.length; // equal prefixes: the longer pattern is the more specific one
}
/** The shape of a pattern with parameter names erased: `/a/:id` and `/a/:name` have the same shape and therefore conflict. */
const shape = (p: string): string => segs(p).map((s) => (s.startsWith(":") ? ":" : s)).join("/");

export function detectRouteConflicts(routes: ResolvedRoute[]): FrontendDiagnostic[] {
  const out: FrontendDiagnostic[] = [];
  const seen = new Map<string, ResolvedRoute>();
  for (const r of routes) {
    const k = shape(r.path), o = seen.get(k);
    if (o) out.push(d("error", "PSO_ROUTE_CONFLICT", o.owner === r.owner ? `route "${r.path}" is declared twice by ${r.owner} (also as "${o.path}")` : `${r.owner} declares "${r.path}", already owned by ${o.owner}`, r.file, o.owner === r.owner ? "Remove or rename one of them" : "A route belongs to exactly one MEI: move it under the mount path of its owner"));
    else seen.set(k, r);
  }
  return out;
}

/** Routes of a MEI must stay under its mount path (they are relative, so only a malformed result can leave it). */
export function checkOwnership(routes: ResolvedRoute[], owner: string, mount: string): FrontendDiagnostic[] {
  return routes.filter((r) => !(r.path === mount || r.path.startsWith(`${mount}/`))).map((r) => d("error", "PSO_ROUTE_OWNERSHIP", `${owner} produced the route "${r.path}", outside its mount path "${mount}"`, r.file));
}

export interface RouteMatch { route: ResolvedRoute; params: Record<string, string> }
/** Resolves a pathname against routes in deterministic precedence order. Returns undefined when nothing matches. */
export function matchRoute(routes: readonly ResolvedRoute[], pathname: string): RouteMatch | undefined {
  const path = segs(pathname.replace(/\/+$/, "") || "/");
  const sorted = [...routes].sort((a, b) => comparePrecedence(a.path, b.path) || (a.path < b.path ? -1 : 1));
  for (const route of sorted) {
    const pat = segs(route.path), params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length && ok; i++) {
      const p = pat[i]!;
      if (p === "*") { params["*"] = path.slice(i).join("/"); break; }
      const v = path[i];
      if (v === undefined) { ok = false; break; }
      if (p.startsWith(":")) { try { params[p.slice(1)] = decodeURIComponent(v); } catch { ok = false; } } else if (p !== v) ok = false;
      if (i === pat.length - 1 && path.length > pat.length && p !== "*") ok = false;
    }
    if (ok && (pat.includes("*") || pat.length === path.length)) return { route, params };
  }
  return undefined;
}

/** Is this pathname a public route of the microfrontend `entry` (see `MicrofrontendEntry.public`)? Protected unless the FEI said otherwise. */
export function isPublicMeiPath(entry: { path: string; public?: boolean | string[] | undefined }, pathname: string): boolean {
  const pub = entry.public;
  if (!pub) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (!(path === entry.path || path.startsWith(`${entry.path}/`))) return false;
  if (pub === true) return true;
  return matchRoute(pub.map((p) => ({ path: joinPath(entry.path, p) }) as ResolvedRoute), path) !== undefined;
}

/**
 * THE rule that decides whether a visitor with no session may open a pathname: the shell's own entry pages (sign-in, the OIDC return, access denied), a FEI route marked public, or a route of a
 * microfrontend the FEI declared public. Everything else is protected. Used by the navigation gate, the session restore at start-up and the session-expiry redirect, so they never disagree.
 */
export function isPublicRoute(fei: { loginPath: string; microfrontends: ReadonlyArray<{ name: string; path: string; public?: boolean | string[] | undefined }> }, ownRoutes: readonly ResolvedRoute[], pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === fei.loginPath || (SHELL_PATHS as readonly string[]).includes(path)) return true;
  const own = matchRoute(ownRoutes, path);
  if (own?.route.meta["public"] === true) return true;
  const mount = ownerOf(fei.microfrontends.map((m) => ({ name: m.name, path: m.path })), path);
  const entry = mount ? fei.microfrontends.find((m) => m.name === mount.name) : undefined;
  return entry ? isPublicMeiPath(entry, path) : false;
}

/** Which registered microfrontend owns this pathname (the longest mount that is a path prefix). */
export function ownerOf(mounts: ReadonlyArray<{ name: string; path: string }>, pathname: string): { name: string; path: string } | undefined {
  let best: { name: string; path: string } | undefined;
  for (const m of mounts) if ((pathname === m.path || pathname.startsWith(`${m.path}/`)) && (!best || m.path.length > best.path.length)) best = m;
  return best;
}

export { DEFAULT_MEI_PORT };

/**
 * Localized navigation metadata: a title is a string or a map by locale. The exact locale wins, then its language (`pt` for `pt-BR`),
 * then the first declared entry, so a missing translation shows something rather than nothing.
 */
export function resolveText(text: string | Record<string, string> | undefined, locale: string): string | undefined {
  if (text === undefined || typeof text === "string") return text;
  return text[locale] ?? text[locale.split("-")[0]!] ?? Object.values(text)[0];
}

/** Breadcrumbs for a pathname from the routes known so far: one entry per path prefix, titled by the most specific matching route or by the segment itself. */
export function breadcrumbsFor(known: ReadonlyArray<{ path: string; title?: string | Record<string, string> }>, pathname: string, locale: string): Array<{ path: string; title: string }> {
  const parts = pathname.split("/").filter(Boolean);
  const routes = known.map((k) => ({ ...k, owner: "", scopes: [] as string[], meta: {}, trail: [], file: "" })) as ResolvedRoute[];
  const out: Array<{ path: string; title: string }> = [];
  for (let i = 1; i <= parts.length; i++) {
    const p = "/" + parts.slice(0, i).join("/");
    const hit = known.find((k) => k.path === p) ?? matchRoute(routes, p)?.route;
    let seg = parts[i - 1]!; try { seg = decodeURIComponent(seg); } catch { /* keep the raw segment */ }
    out.push({ path: p, title: resolveText(hit?.title, locale) ?? seg });
  }
  return out;
}
