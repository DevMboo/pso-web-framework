import { copyFileSync, statSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { sha256 } from "../crypto.ts";
import { redactText } from "../redact.ts";
import type { NginxDecl } from "../declare.ts";
import { probe } from "./runtime.ts";
import { gzipDirectives, renderSiteLocations } from "@pso/frontend/release";
import { ensureDir, nowIso, type Policy } from "./state.ts";

/**
 * The NGINX adapter.
 *
 * What PSO owns: files whose first line is the ownership marker below and whose name starts with `pso-`. What PSO never does: touch any
 * other file, replace nginx.conf, publish the management plane (the agent has no network endpoint to publish), obtain certificates or
 * change DNS. Every change is: back up -> write -> `nginx -t` -> reload gracefully; a failed test restores the previous files and nginx
 * is not reloaded, so the running configuration stays the last valid one.
 */
export const MARKER = "# Managed by PSO Web";
export const marker = (app: string): string => `${MARKER} (app=${app}). Do not edit: changes are overwritten by the next deployment.`;
export const isManagedBy = (content: string, app: string): boolean => content.split("\n", 1)[0] === marker(app);
export const isManaged = (content: string): boolean => content.startsWith(MARKER);

export interface RouteInstance { service: string; ports: number[]; /** loopback port that always reaches the active release of this service */ stablePort: number; route?: { path: string } }
export interface VhostInput { app: string; release: string; services: RouteInstance[]; nginx: NginxDecl | undefined; /** directory whose PSO-managed *.conf files are included in the public and loopback servers (nginx.attachPoint) */ attachDir?: string }

/** Where the locations of frontends attached to `host` live: a subdirectory of the managed directory that the http-level include (`*.conf` of the directory itself) never loads. */
/**
 * Can the web server read files under `dir`? nginx workers run as an unprivileged user (usually www-data); a directory below a home directory
 * with mode 750, or below the agent's own 700 directory, answers 403 for every file. Checked from the permission bits of the directory and its
 * existing ancestors: every one must be traversable by "others" (o+x), because the agent does not know the worker's groups. Returns the first
 * obstacle, or undefined. (A server whose workers share a group with the owner can still use it: the administrator says so by choosing staticRoot.)
 */
export function webServerCannotRead(dir: string, workerUser = "www-data"): string | undefined {
  let p = dir; const chain: string[] = [];
  while (true) { chain.push(p); const up = posix.dirname(p); if (up === p) break; p = up; }
  for (const d of chain.reverse()) {
    let st: { mode: number }; try { st = statSync(d); } catch { continue; } // a directory that does not exist yet is created by the agent under an ancestor that does
    if ((st.mode & 0o001) === 0) return `${d} is mode ${(st.mode & 0o777).toString(8)} and is not traversable by other users: the web server (${workerUser}) would answer 403 for every file below it`;
  }
  return undefined;
}

export const attachDirFor = (policy: Pick<Policy, "nginxManagedDir">, host: string): string => posix.join(policy.nginxManagedDir, "attach", host);

const upstreamName = (app: string, service: string): string => `pso_${app.replace(/-/g, "_")}_${service.replace(/-/g, "_")}`;

/** One managed file per application: upstreams, a loopback listener per service, and (when a route or domain is declared) the public server. */
export function renderConfig(i: VhostInput): string {
  const { app, release } = i;
  const ng = i.nginx ?? {};
  const out: string[] = [marker(app), `# pso-release: ${release}`, `# generated: ${nowIso()}`, ""];
  const ws = ng.websocket !== false;
  const upg = `$pso_${app.replace(/-/g, "_")}_upgrade`;
  if (ws) out.push(`map $http_upgrade ${upg} { default upgrade; '' close; }`, "");
  for (const s of i.services) {
    out.push(`upstream ${upstreamName(app, s.service)} {`);
    for (const p of s.ports) out.push(`    server 127.0.0.1:${p};`);
    out.push("    keepalive 16;", "}", "");
  }
  const proxyBlock = (s: RouteInstance, indent: string): string[] => [
    `${indent}proxy_pass http://${upstreamName(app, s.service)};`,
    `${indent}proxy_http_version 1.1;`,
    `${indent}proxy_set_header Host $host;`,
    `${indent}proxy_set_header X-Real-IP $remote_addr;`,
    `${indent}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `${indent}proxy_set_header X-Forwarded-Proto $scheme;`,
    ws ? `${indent}proxy_set_header Upgrade $http_upgrade;` : `${indent}proxy_set_header Connection "";`,
    ...(ws ? [`${indent}proxy_set_header Connection ${upg};`] : []),
    `${indent}proxy_connect_timeout 3s;`,
    `${indent}proxy_read_timeout 120s;`,
    `${indent}proxy_next_upstream error timeout http_502 http_503;`,
  ];
  // loopback listener per service: internal consumers keep one stable address while releases are swapped behind it
  for (const s of i.services) {
    out.push("server {", `    listen 127.0.0.1:${s.stablePort};`, `    server_name _;`, `    add_header X-PSO-Release ${release} always;`, ...(i.attachDir ? [`    include ${i.attachDir}/*.conf;`] : []), "    location / {", ...proxyBlock(s, "        "), "    }", "}", "");
  }
  const routed = i.services.filter((s) => s.route);
  if (routed.length) {
    const http = ng.listen?.http ?? 80; const https = ng.listen?.https;
    const names = ng.domains?.length ? ng.domains.join(" ") : "_";
    const tls = ng.tls && https;
    const body = (indent: string): string[] => [
      `${indent}server_tokens off;`,
      `${indent}add_header X-PSO-Release ${release} always;`,
      ...(i.attachDir ? [`${indent}include ${i.attachDir}/*.conf;`] : []),
      ...routed.sort((a, b) => b.route!.path.length - a.route!.path.length).flatMap((s) => [`${indent}location ${s.route!.path} {`, ...proxyBlock(s, indent + "    "), `${indent}}`]),
    ];
    if (tls) {
      out.push("server {", `    listen ${http};`, `    server_name ${names};`, "    return 301 https://$host$request_uri;", "}", "");
      out.push("server {", `    listen ${https} ssl;`, `    server_name ${names};`, `    ssl_certificate ${ng.tls!.certificate};`, `    ssl_certificate_key ${ng.tls!.key};`, "    ssl_protocols TLSv1.2 TLSv1.3;", ...body("    "), "}", "");
    } else out.push("server {", `    listen ${http};`, `    server_name ${names};`, ...body("    "), "}", "");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ layout and privileges
export interface NginxTarget { file: string; link?: string }

/** Directories PSO may write nginx files into: the usual nginx include directories and the PSO-owned directory of this server. Nothing else, whatever a declaration says. */
export const allowedNginxRoots = (policy: Pick<Policy, "nginxManagedDir">): string[] => [policy.nginxManagedDir, "/etc/nginx/sites-available", "/etc/nginx/sites-enabled", "/etc/nginx/conf.d", "/etc/nginx/http.d", "/etc/nginx/pso.d", "/usr/local/etc/nginx/conf.d", "/usr/local/etc/nginx/pso.d"].map((d) => posix.normalize(d).replace(/\/+$/, ""));
const under = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");

/**
 * A layout chosen in a declaration is untrusted input. It must be an absolute path WITHOUT dot segments that lies inside an allowed root, so
 * "/etc/nginx/../../tmp" and "/srv/anywhere" are refused (the check is on the text, before anything touches the disk).
 */
export function assertSafeLayout(layout: string, policy: Pick<Policy, "nginxManagedDir">): string {
  if (!layout.startsWith("/") || layout.split("/").some((s) => s === ".." || s === ".")) throw new Error(`nginx layout "${layout}" is not acceptable: an absolute path without "." or ".." segments is required`);
  const norm = posix.normalize(layout).replace(/\/+$/, "");
  if (!allowedNginxRoots(policy).some((r) => under(norm, r))) throw new Error(`nginx layout "${layout}" is outside the directories PSO may manage (${allowedNginxRoots(policy).join(", ")})`);
  return norm;
}

/**
 * Before PSO writes, the REAL location must still be inside an allowed root: a symlinked directory (or a symlinked target file) that leads out
 * of them is refused. An existing `sites-enabled` entry must be the symbolic link to OUR file, never a regular file or a link elsewhere.
 */
export function assertSafeWriteTarget(target: NginxTarget, policy: Pick<Policy, "nginxManagedDir">): string | undefined {
  const roots = allowedNginxRoots(policy);
  const realOf = (p: string): string | undefined => { try { return realpathSync(p).split("\\").join("/"); } catch { return undefined; } };
  const dir = posix.dirname(target.file); const realDir = realOf(dir);
  if (realDir !== undefined) { const realRoots = roots.map((r) => realOf(r) ?? r); if (!realRoots.some((r) => under(realDir, r))) return `${dir} resolves to ${realDir}, outside the directories PSO may manage: refusing to write there`; }
  try { const st = lstatSync(target.file); if (st.isSymbolicLink()) return `${target.file} is a symbolic link: PSO will not write through it`; if (!st.isFile()) return `${target.file} is not a regular file`; } catch { /* does not exist yet */ }
  if (target.link) {
    try { const st = lstatSync(target.link); if (!st.isSymbolicLink()) return `${target.link} exists and is not a symbolic link: it is not PSO's`; const to = readlinkSync(target.link); if (posix.resolve(posix.dirname(target.link), to) !== posix.resolve(target.file)) return `${target.link} is a symbolic link to ${to}, not to ${target.file}: it is not PSO's`; } catch { /* does not exist yet */ }
  }
  return undefined;
}

export function targetFor(policy: Pick<Policy, "nginxLayout" | "nginxManagedDir">, app: string, layout?: string): NginxTarget {
  const name = `pso-${app}.conf`;
  const l = layout ?? policy.nginxLayout;
  if (l === "sites") return { file: `/etc/nginx/sites-available/${name}`, link: `/etc/nginx/sites-enabled/${name}` };
  if (l === "conf.d") return { file: `/etc/nginx/conf.d/${name}` };
  // the agent runs on Linux: server paths are POSIX paths whatever machine builds the plan
  if (l === "pso.d") return { file: posix.join(policy.nginxManagedDir, name) };
  if (l.startsWith("/")) return { file: posix.join(assertSafeLayout(l, policy), name) };
  throw new Error(`unknown nginx layout "${l}"`);
}

export function findNginx(): string | undefined {
  if (process.env["PSO_NGINX_BIN"]) return process.env["PSO_NGINX_BIN"];
  for (const d of ["/usr/sbin", "/usr/local/sbin", "/usr/bin", "/usr/local/bin", "/sbin"]) if (existsSync(join(d, "nginx"))) return join(d, "nginx");
  return undefined;
}

export function nginxCommand(policy: Pick<Policy, "nginxPrivilege">, args: string[]): { cmd: string; args: string[] } | undefined {
  const bin = findNginx(); if (!bin) return undefined;
  return policy.nginxPrivilege === "sudo" && process.getuid?.() !== 0 ? { cmd: "sudo", args: ["-n", bin, ...args] } : { cmd: bin, args };
}

export const nginxTest = (p: Pick<Policy, "nginxPrivilege">): { ok: boolean; out: string } => { const c = nginxCommand(p, ["-t"]); return c ? probe(c.cmd, c.args) : { ok: false, out: "nginx is not installed" }; };
export const nginxReload = (p: Pick<Policy, "nginxPrivilege">): { ok: boolean; out: string } => { const c = nginxCommand(p, ["-s", "reload"]); return c ? probe(c.cmd, c.args) : { ok: false, out: "nginx is not installed" }; };

// ------------------------------------------------------------------ apply with backup / validation / rollback
export interface ApplyResult { changed: boolean; reloaded: boolean; backupId?: string; contentHash: string; error?: string; testOutput?: string; restored?: boolean }

const backupRoot = (home: string): string => join(home, "nginx", "backups");

export function planProxyChange(target: NginxTarget, app: string, content: string): { action: "create" | "update" | "unchanged" | "conflict"; reason?: string } {
  if (!existsSync(target.file)) return { action: "create" };
  const cur = readFileSync(target.file, "utf8");
  if (!isManagedBy(cur, app)) return { action: "conflict", reason: `${target.file} exists and is not managed by PSO for app "${app}": it will not be modified` };
  const strip = (s: string): string => s.split("\n").filter((l) => !l.startsWith("# generated:")).join("\n");
  return { action: strip(cur) === strip(content) ? "unchanged" : "update" };
}

export function applyProxy(home: string, policy: Pick<Policy, "nginxPrivilege" | "nginxManagedDir">, target: NginxTarget, app: string, content: string, deploymentId: string): ApplyResult {
  const hash = sha256(content);
  const unsafe = assertSafeWriteTarget(target, policy); if (unsafe) return { changed: false, reloaded: false, contentHash: hash, error: unsafe };
  const plan = planProxyChange(target, app, content);
  if (plan.action === "conflict") return { changed: false, reloaded: false, contentHash: hash, error: plan.reason! };
  if (plan.action === "unchanged") return { changed: false, reloaded: false, contentHash: hash };
  const backupId = `${deploymentId}-${Date.now()}`;
  const bdir = join(backupRoot(home), backupId); ensureDir(bdir);
  const had = existsSync(target.file);
  if (had) copyFileSync(target.file, join(bdir, basename(target.file)));
  writeFileSync(join(bdir, "meta.json"), JSON.stringify({ file: target.file, link: target.link, had, app, at: nowIso() }));
  const restore = (): void => {
    try { if (had) copyFileSync(join(bdir, basename(target.file)), target.file); else rmSync(target.file, { force: true }); } catch { /* reported by the caller */ }
    if (!had && target.link) { try { unlinkSync(target.link); } catch { /* not there */ } }
  };
  try {
    ensureDir(dirname(target.file), 0o755);
    const tmp = `${target.file}.pso-${process.pid}.tmp`;
    writeFileSync(tmp, content, { mode: 0o644 }); renameSync(tmp, target.file);
    if (target.link && !existsSync(target.link)) { try { symlinkSync(target.file, target.link); } catch (e) { restore(); return { changed: false, reloaded: false, backupId, contentHash: hash, restored: true, error: `cannot enable the site: ${(e as Error).message}` }; } }
  } catch (e) { restore(); return { changed: false, reloaded: false, backupId, contentHash: hash, restored: true, error: `cannot write ${target.file}: ${(e as Error).message}` }; }
  const t = nginxTest(policy);
  if (!t.ok) { restore(); return { changed: false, reloaded: false, backupId, contentHash: hash, restored: true, error: "nginx rejected the new configuration; the previous configuration was kept and nginx was not reloaded", testOutput: redactText(t.out) }; }
  const r = nginxReload(policy);
  if (!r.ok) { restore(); const again = nginxReload(policy); return { changed: false, reloaded: false, backupId, contentHash: hash, restored: true, error: `nginx reload failed (${redactText(r.out).slice(0, 300)}); previous files restored${again.ok ? " and reloaded" : ""}` }; }
  return { changed: true, reloaded: true, backupId, contentHash: hash };
}

/** Backups made by applyProxy for one application (newest first). */
export function listBackups(home: string, app: string): Array<{ id: string; file: string; at: string; had: boolean }> {
  const root = backupRoot(home); if (!existsSync(root)) return [];
  const out: Array<{ id: string; file: string; at: string; had: boolean }> = [];
  for (const id of readdirSync(root)) { try { const m = JSON.parse(readFileSync(join(root, id, "meta.json"), "utf8")) as { file: string; app: string; at: string; had: boolean }; if (m.app === app) out.push({ id, file: m.file, at: m.at, had: m.had }); } catch { /* not a backup */ } }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
}

/** Restores the files saved by `applyProxy` (rollback of PSO-managed proxy changes). Validates and reloads like any other change. */
export function restoreProxy(home: string, policy: Pick<Policy, "nginxPrivilege">, backupId: string): { ok: boolean; error?: string } {
  const bdir = join(backupRoot(home), backupId);
  if (!/^[A-Za-z0-9_.-]+$/.test(backupId) || !existsSync(join(bdir, "meta.json"))) return { ok: false, error: "unknown backup" };
  const meta = JSON.parse(readFileSync(join(bdir, "meta.json"), "utf8")) as { file: string; link?: string; had: boolean };
  const cur = existsSync(meta.file) ? readFileSync(meta.file, "utf8") : "";
  if (cur && !isManaged(cur)) return { ok: false, error: "the file is no longer managed by PSO; not touching it" };
  if (meta.had) copyFileSync(join(bdir, basename(meta.file)), meta.file); else { rmSync(meta.file, { force: true }); if (meta.link) { try { unlinkSync(meta.link); } catch { /* absent */ } } }
  const t = nginxTest(policy); if (!t.ok) return { ok: false, error: `restored files fail nginx -t: ${redactText(t.out).slice(0, 300)}` };
  const r = nginxReload(policy); return r.ok ? { ok: true } : { ok: false, error: `reload failed: ${redactText(r.out).slice(0, 300)}` };
}

// ------------------------------------------------------------------ discovery of existing configuration
export interface VhostInfo { file: string; managed: boolean; app?: string; serverNames: string[]; listens: string[] }

export function discoverVhosts(dirs: string[]): VhostInfo[] {
  const out: VhostInfo[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const file = join(d, f);
      try {
        const st = lstatSync(file); if (!st.isFile() && !st.isSymbolicLink()) continue;
        const text = readFileSync(file, "utf8");
        const app = /^# Managed by PSO Web \(app=([a-z0-9-]+)\)/.exec(text)?.[1];
        out.push({ file: st.isSymbolicLink() ? `${file} -> ${readlinkSync(file)}` : file, managed: !!app, ...(app ? { app } : {}),
          serverNames: [...text.matchAll(/^\s*server_name\s+([^;]+);/gm)].flatMap((m) => m[1]!.trim().split(/\s+/)),
          listens: [...text.matchAll(/^\s*listen\s+([^;]+);/gm)].map((m) => m[1]!.trim()) });
      } catch { /* unreadable: ignored */ }
    }
  }
  return out;
}

export const defaultDiscoveryDirs = (policy: Pick<Policy, "nginxManagedDir">): string[] => [policy.nginxManagedDir, "/etc/nginx/sites-enabled", "/etc/nginx/conf.d", "/etc/nginx/http.d"];

/** Conflicts between the planned file and configuration PSO does not own (same server_name and listen port). */
export function findConflicts(planned: { serverNames: string[]; listenPorts: string[] }, existing: VhostInfo[], app: string): string[] {
  const out: string[] = [];
  for (const v of existing) {
    if (v.managed && v.app === app) continue;
    const portOverlap = v.listens.some((l) => planned.listenPorts.includes(l.replace(/^.*:/, "").replace(/\s.*$/, "")));
    const nameOverlap = v.serverNames.some((n) => n !== "_" && planned.serverNames.includes(n));
    if (portOverlap && nameOverlap) out.push(`${v.file} already serves ${v.serverNames.filter((n) => planned.serverNames.includes(n)).join(", ")} on the same port${v.managed ? ` (managed by PSO for app "${v.app}")` : " (not managed by PSO)"}`);
  }
  return out;
}


// ------------------------------------------------------------------ static frontend resources (FEI)
export interface StaticVhostInput {
  app: string; release: string; site: string;
  fei: { basePath: string; routes?: string[]; connectSrc?: string[]; api?: { path?: string; upstreamPort: number; channelsPath?: string } };
  nginx: NginxDecl | undefined;
  /** loopback port of an extra plain-HTTP listener PSO verifies the active release through (needed when the public port only redirects to HTTPS) */
  probePort?: number;
}

/**
 * The managed file of a SHELL: the same locations `pso frontend:nginx` previews (they come from one function in `@pso/frontend/release`),
 * wrapped in the usual PSO ownership marker and, when TLS is declared, an HTTP to HTTPS redirect. The shell's file also serves `/_mei/`:
 * every microfrontend release is served through it, so publishing a MEI never needs a change to nginx.
 */
export function renderStaticConfig(i: StaticVhostInput): string {
  const { app, release } = i; const ng = i.nginx ?? {};
  const upg = `$pso_${app.replace(/-/g, "_")}_upgrade`;
  const http = ng.listen?.http ?? 80; const https = ng.listen?.https; const names = ng.domains?.length ? ng.domains.join(" ") : "_";
  const tls = !!(ng.tls && https);
  const api = i.fei.api ? { path: i.fei.api.path ?? "/api", port: i.fei.api.upstreamPort, ...(i.fei.api.channelsPath ? { channelsPath: i.fei.api.channelsPath } : {}) } : undefined;
  const locs = (withTls: boolean): string[] => renderSiteLocations({ site: i.site, fei: { base: i.fei.basePath, ...(i.fei.routes ? { routes: i.fei.routes } : {}) }, ...(i.fei.connectSrc ? { connectSrc: i.fei.connectSrc } : {}), remotes: true, ...(api ? { api } : {}), upgradeVar: upg, release, tls: withTls }, "    ");
  const out: string[] = [marker(app), `# pso-release: ${release}`, `# generated: ${nowIso()}`, "", `map $http_upgrade ${upg} { default upgrade; '' close; }`, ""];
  const server = (head: string[], withTls: boolean): void => { out.push("server {", ...head, "    server_tokens off;", ...gzipDirectives("    "), ...locs(withTls), "}", ""); };
  if (tls) {
    out.push("server {", `    listen ${http};`, `    server_name ${names};`, "    return 301 https://$host$request_uri;", "}", "");
    server([`    listen ${https} ssl;`, `    server_name ${names};`, `    ssl_certificate ${ng.tls!.certificate};`, `    ssl_certificate_key ${ng.tls!.key};`, "    ssl_protocols TLSv1.2 TLSv1.3;"], true);
    if (i.probePort) server([`    listen 127.0.0.1:${i.probePort};`, "    server_name _;"], false);
  } else server([`    listen ${http};`, `    server_name ${names};`], false);
  return out.join("\n");
}

/**
 * The managed file of a SHELL that joins another application's server (nginx.attachTo): only the shell's locations, no server, no listener,
 * no certificate. The host's server includes this directory, so the frontend shares its address, port and TLS while its releases stay
 * independent of the host's: updating the shell rewrites this file (validated with nginx -t, graceful reload), updating a microfrontend
 * does not touch nginx at all, and neither needs a deployment of the host.
 */
export function renderStaticFragment(i: StaticVhostInput): string {
  const locs = renderSiteLocations({ site: i.site, fei: { base: i.fei.basePath, ...(i.fei.routes ? { routes: i.fei.routes } : {}) }, ...(i.fei.connectSrc ? { connectSrc: i.fei.connectSrc } : {}), remotes: true, release: i.release, tls: true }, "    ");
  return [marker(i.app), `# pso-release: ${i.release}`, `# attached-to: ${i.nginx?.attachTo ?? ""}`, `# generated: ${nowIso()}`, "", ...locs, ""].join("\n");
}
