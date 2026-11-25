import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, posix } from "node:path";
import { userInfo } from "node:os";
import { probe } from "./runtime.ts";

/**
 * Operational visibility: what listens where, what the deploy user can really do with sudo, and what nginx is configured to do.
 * Everything here is READ-ONLY inspection of the server; nothing is changed. What cannot be determined is reported as unknown, never as fine.
 */

// ================================================================== network exposure
export type Binding = "loopback" | "all-interfaces" | "private" | "public-address";
export type Verdict = "ok" | "intentionally-public" | "unexpected-all-interfaces" | "unexpected-private-binding" | "unclassified-all-interfaces";
export interface Listener {
  port: number; address: string; family: "ipv4" | "ipv6"; binding: Binding;
  process?: { name: string; pid: number; user?: string };
  component: string; componentSource: "process" | "pso-slot" | "pso-nginx" | "well-known-port" | "unknown";
  ownership: "pso-managed" | "system" | "external" | "unknown";
  intent: "internal" | "public" | "administrative";
  verdict: Verdict; reason: string;
  /** what the server itself can know about reachability from outside: nothing. A client verifies it separately */
  externalReachability: "unknown";
}
export interface ExposurePolicy { intentionallyPublicPorts: number[]; infrastructureNetwork: "single-server" | "distributed" }

const WELL_KNOWN: Record<number, { component: string; intent: Listener["intent"]; infra: boolean }> = {
  22: { component: "sshd", intent: "administrative", infra: false }, 80: { component: "nginx", intent: "public", infra: false }, 443: { component: "nginx", intent: "public", infra: false },
  5432: { component: "postgresql", intent: "internal", infra: true }, 3306: { component: "mysql", intent: "internal", infra: true }, 6379: { component: "redis", intent: "internal", infra: true },
  5672: { component: "rabbitmq", intent: "internal", infra: true }, 15672: { component: "rabbitmq-management", intent: "internal", infra: true }, 25672: { component: "rabbitmq-distribution", intent: "internal", infra: true },
  4369: { component: "erlang-epmd", intent: "internal", infra: true }, 9092: { component: "kafka", intent: "internal", infra: true }, 9093: { component: "kafka", intent: "internal", infra: true }, 2181: { component: "zookeeper", intent: "internal", infra: true },
};
const PROCESS_COMPONENT: Array<[RegExp, string]> = [[/^nginx$/, "nginx"], [/^sshd/, "sshd"], [/^postgres/, "postgresql"], [/^redis/, "redis"], [/^beam/, "rabbitmq"], [/^epmd$/, "erlang-epmd"], [/^systemd-resolve/, "systemd-resolved"], [/^node$/, "node"], [/^java$/, "java"]];

const hexV4 = (h: string): string => [3, 2, 1, 0].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)).join(".");
export function hexV6(h: string): string {
  h = h.toLowerCase();
  const words: string[] = []; for (let w = 0; w < 4; w++) { const part = h.slice(w * 8, w * 8 + 8); const b = [3, 2, 1, 0].map((i) => part.slice(i * 2, i * 2 + 2)); words.push(b[0]! + b[1]!, b[2]! + b[3]!); }
  const groups = words.map((x) => x.replace(/^0+(?=.)/, "")); if (groups.every((g) => g === "0")) return "::";
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") return `::ffff:${parseInt(words[6]!.slice(0, 2), 16)}.${parseInt(words[6]!.slice(2), 16)}.${parseInt(words[7]!.slice(0, 2), 16)}.${parseInt(words[7]!.slice(2), 16)}`;
  if (groups.slice(0, 7).every((g) => g === "0") && groups[7] === "1") return "::1";
  return groups.join(":");
}
export function classifyBinding(address: string): Binding {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  if (a === "0.0.0.0" || a === "::" || a === "*") return "all-interfaces";
  if (/^127\./.test(a) || a === "::1") return "loopback";
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a) || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return "private";
  return "public-address";
}

export interface RawListener { port: number; address: string; family: "ipv4" | "ipv6" }
export function readListeners(): RawListener[] {
  const out: RawListener[] = [];
  for (const [f, fam] of [["/proc/net/tcp", "ipv4"], ["/proc/net/tcp6", "ipv6"]] as const) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/); if (c[3] !== "0A" || !c[1]) continue; const [a, p] = c[1].split(":");
      out.push({ port: parseInt(p!, 16), address: fam === "ipv4" ? hexV4(a!) : hexV6(a!), family: fam });
    }
  }
  return out.filter((l, i, arr) => arr.findIndex((m) => m.port === l.port && m.address === l.address) === i).sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}
/** Processes visible to THIS user only (ss shows others' sockets without their process). Unowned listeners are labelled as inferred, never as verified. */
export function readProcessOwners(): Map<string, { name: string; pid: number; user?: string }> {
  const m = new Map<string, { name: string; pid: number; user?: string }>(); const r = probe("ss", ["-ltnpH"], 8000); if (!r.ok) return m;
  for (const l of r.out.split("\n")) {
    const c = l.trim().split(/\s+/); const local = c[3]; const u = /users:\(\("([^"]+)",pid=(\d+)/.exec(l); if (!local || !u) continue;
    const idx = local.lastIndexOf(":"); const port = Number(local.slice(idx + 1)); const addr = local.slice(0, idx).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    let user: string | undefined; try { const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${u[2]}/status`, "utf8"))?.[1]; user = uid === String(process.getuid?.()) ? userInfo().username : uid ? `uid ${uid}` : undefined; } catch { /* gone */ }
    m.set(`${addr === "*" ? "0.0.0.0" : addr}:${port}`, { name: u[1]!, pid: Number(u[2]), ...(user ? { user } : {}) });
  }
  return m;
}

export interface ExposureInput { listeners: RawListener[]; owners: Map<string, { name: string; pid: number; user?: string }>; policy: ExposurePolicy; psoPorts: Map<number, { app: string; service: string }>; nginxDeclaredPorts: Set<number> }
export function assessExposure(i: ExposureInput): Listener[] {
  return i.listeners.map((l): Listener => {
    const binding = classifyBinding(l.address); const owner = i.owners.get(`${l.address}:${l.port}`) ?? i.owners.get(`${l.address.replace(/^::ffff:/, "")}:${l.port}`);
    let component = "unknown"; let source: Listener["componentSource"] = "unknown"; let intent: Listener["intent"] = "internal"; let ownership: Listener["ownership"] = "unknown"; let infra = false;
    const pso = i.psoPorts.get(l.port);
    if (pso) { component = `${pso.app}/${pso.service}`; source = "pso-slot"; ownership = "pso-managed"; }
    else if (owner) { component = PROCESS_COMPONENT.find(([re]) => re.test(owner.name))?.[1] ?? owner.name; source = "process"; }
    const known = WELL_KNOWN[l.port];
    if (!pso && known) { if (source === "unknown") { component = known.component; source = "well-known-port"; } intent = known.intent; infra = known.infra; }
    if (!pso && !known && i.nginxDeclaredPorts.has(l.port)) { component = "nginx"; source = "pso-nginx"; ownership = "pso-managed"; intent = "public"; }
    if (ownership === "unknown") ownership = ["sshd", "systemd-resolved"].includes(component) ? "system" : infra || known ? "external" : "unknown";
    if (!pso && owner && /^(java|node)$/.test(owner.name) && ownership === "unknown") ownership = "external";
    const declaredPublic = i.policy.intentionallyPublicPorts.includes(l.port) || i.nginxDeclaredPorts.has(l.port);
    let verdict: Verdict; let reason: string;
    if (binding === "loopback") { verdict = "ok"; reason = "loopback only: not reachable from another machine"; }
    else if (declaredPublic) { verdict = "intentionally-public"; reason = i.policy.intentionallyPublicPorts.includes(l.port) ? "port is in the environment's intentionally-public list" : "port is declared by a PSO-managed nginx server block"; }
    else if (binding === "private" && i.policy.infrastructureNetwork === "distributed" && (infra || pso)) { verdict = "ok"; reason = "private-network address of infrastructure in a distributed environment (policy)"; }
    else if (binding === "private") { verdict = "unexpected-private-binding"; reason = "bound to a private interface address; a single-server environment expects loopback for internal components"; }
    else if (infra || pso) { verdict = "unexpected-all-interfaces"; reason = `${component} is internal infrastructure but listens on ${binding === "all-interfaces" ? "all interfaces" : "a public address"}`; }
    else { verdict = "unclassified-all-interfaces"; reason = "listens on " + (binding === "all-interfaces" ? "all interfaces" : "a non-private address") + " and is neither declared public nor a recognised internal component"; }
    return { port: l.port, address: l.address, family: l.family, binding, ...(owner ? { process: owner } : {}), component, componentSource: source, ownership, intent, verdict, reason, externalReachability: "unknown" };
  });
}

export interface Finding { severity: "high" | "medium" | "info"; component: string; address: string; port: number; title: string; implication: string; remediation: string[] }
const REMEDIATION: Record<string, string[]> = {
  rabbitmq: ["Edit /etc/rabbitmq/rabbitmq-env.conf: NODE_IP_ADDRESS=127.0.0.1, ERL_EPMD_ADDRESS=127.0.0.1, NODENAME=rabbit@localhost, SERVER_ADDITIONAL_ERL_ARGS=\"-kernel inet_dist_use_interface {127,0,0,1}\"", "Bind the Erlang port mapper: a systemd drop-in for epmd.socket with ListenStream= then ListenStream=127.0.0.1:4369", "sudo systemctl daemon-reload && sudo systemctl restart epmd.socket rabbitmq-server (this restarts RabbitMQ: consumers reconnect)"],
  "rabbitmq-distribution": ["See rabbitmq: inet_dist_use_interface and NODE_IP_ADDRESS keep the distribution port on loopback"],
  "rabbitmq-management": ["Set management.tcp.ip = 127.0.0.1 in rabbitmq.conf, then restart RabbitMQ"],
  "erlang-epmd": ["epmd.socket drop-in: ListenStream= then ListenStream=127.0.0.1:4369; restart epmd.socket"],
  redis: ["Set `bind 127.0.0.1 -::1` in /etc/redis/redis.conf (and keep protected-mode yes), then restart redis-server"],
  postgresql: ["Set listen_addresses = 'localhost' in postgresql.conf and restrict pg_hba.conf, then restart PostgreSQL (existing connections drop)"],
  kafka: ["Set listeners=PLAINTEXT://127.0.0.1:9092 and advertised.listeners accordingly in server.properties, then restart Kafka"],
  mysql: ["Set bind-address = 127.0.0.1 in the MySQL configuration, then restart the service"],
  zookeeper: ["Set clientPortAddress=127.0.0.1 in zoo.cfg, then restart ZooKeeper"],
};
export function findingsOf(l: Listener[]): Finding[] {
  const out: Finding[] = [];
  for (const x of l) {
    if (x.verdict === "ok" || x.verdict === "intentionally-public") continue;
    const base = x.component.split("/")[0]!;
    const rem = REMEDIATION[x.component] ?? REMEDIATION[base] ?? ["Restrict the listener to 127.0.0.1 in that component's own configuration, or block the port with a host firewall rule, then verify with `ss -ltn`"];
    out.push({
      severity: x.verdict === "unexpected-all-interfaces" ? "high" : "medium", component: x.component, address: x.address, port: x.port,
      title: x.verdict === "unexpected-all-interfaces" ? `${x.component} listens on ${x.address}:${x.port} (all interfaces)` : x.verdict === "unexpected-private-binding" ? `${x.component} listens on private address ${x.address}:${x.port}` : `unclassified listener ${x.address}:${x.port}`,
      implication: "A listener on all interfaces is POTENTIALLY reachable from the network. Whether it is actually reachable depends on firewalls and cloud network rules that this server cannot see; PSO therefore reports it as potentially unsafe, not as publicly reachable.",
      remediation: x.verdict === "unclassified-all-interfaces" ? ["Identify the owner: sudo ss -ltnp | grep :" + x.port, "If it is intended to be public, add the port to the environment's intentionally-public list (pso environment:policy --set intentionallyPublicPorts=...)", ...rem] : rem,
    });
  }
  return out;
}

// ================================================================== effective sudo privilege
export type PrivilegeLevel = "root" | "none" | "restricted" | "broad" | "unrestricted" | "unknown";
export interface PrivilegeReport { user: string; uid: number; groups: string[]; privilegedGroups: string[]; level: PrivilegeLevel; passwordless: boolean | "unknown"; commands: string[]; evidence: string[]; narrowPolicyVerified: boolean; recommendation: string }
const SHELLISH = /(^|\/)(sh|bash|dash|zsh|ksh|su|env|vi|vim|nano|less|more|man|find|awk|perl|python[0-9.]*|ruby|node|nodejs|php|tar|zip|rsync|ssh|scp|nmap|tee|dd|cp|mv|chmod|chown|systemctl|docker|mount|visudo|sudoedit|passwd|useradd|usermod)$/;
/** Pure parser of `sudo -l` output. Exported for tests. */
export function classifySudoList(text: string): { level: PrivilegeLevel; commands: string[]; passwordless: boolean | "unknown" } {
  const lines = text.split("\n"); const i = lines.findIndex((l) => /may run the following commands/i.test(l));
  if (/is not allowed to run sudo|may not run sudo/i.test(text) && i < 0) return { level: "none", commands: [], passwordless: false };
  if (i < 0) return { level: "unknown", commands: [], passwordless: "unknown" };
  const cmds: string[] = []; let pwless: boolean | "unknown" = "unknown"; let anyNopasswd = false, anyPasswd = false;
  for (const raw of lines.slice(i + 1)) {
    const l = raw.trim(); if (!l) continue; const m = /^\(([^)]*)\)\s*(.*)$/.exec(l); if (!m) continue;
    let rest = m[2]!; const tags: string[] = []; for (let t = /^([A-Z_]+):\s*/.exec(rest); t; t = /^([A-Z_]+):\s*/.exec(rest)) { tags.push(t[1]!); rest = rest.slice(t[0].length); }
    if (tags.includes("NOPASSWD")) anyNopasswd = true; else anyPasswd = true;
    for (const c of rest.split(/,(?![^"]*")/)) { const cc = c.trim(); if (cc) cmds.push(cc); }
  }
  pwless = anyNopasswd && !anyPasswd ? true : anyNopasswd && anyPasswd ? "unknown" : false;
  if (cmds.some((c) => c === "ALL" || /^ALL\b/.test(c))) return { level: "unrestricted", commands: cmds, passwordless: pwless };
  if (cmds.some((c) => /[*?]/.test(c) || SHELLISH.test(c.split(/\s+/)[0] ?? "") || /\/$/.test(c.split(/\s+/)[0] ?? ""))) return { level: "broad", commands: cmds, passwordless: pwless };
  return { level: cmds.length ? "restricted" : "none", commands: cmds, passwordless: pwless };
}
export function inspectPrivilege(): PrivilegeReport {
  const u = userInfo(); const uid = process.getuid?.() ?? -1; const evidence: string[] = [];
  const g = probe("id", ["-nG"]); const groups = g.ok ? g.out.split(/\s+/).filter(Boolean) : []; const priv = groups.filter((x) => ["sudo", "admin", "wheel", "root", "docker", "lxd", "disk", "adm"].includes(x));
  if (uid === 0) return { user: u.username, uid, groups, privilegedGroups: priv, level: "root", passwordless: true, commands: ["ALL"], evidence: ["the agent runs as root"], narrowPolicyVerified: false, recommendation: "Do not run the PSO agent as root: use a dedicated unprivileged deploy user." };
  const sudoBin = probe("sh", ["-c", "command -v sudo"]); if (!sudoBin.ok) return { user: u.username, uid, groups, privilegedGroups: priv, level: "none", passwordless: false, commands: [], evidence: ["sudo is not installed"], narrowPolicyVerified: false, recommendation: "nginx -t / reload need a narrow sudo rule (see provision:plan) or a different privilege mechanism." };
  const l = probe("sudo", ["-n", "-l"], 8000); evidence.push(`sudo -n -l: ${l.ok ? "listed" : (l.out.split("\n")[0] ?? "failed").slice(0, 120)}`);
  if (priv.includes("sudo") || priv.includes("admin") || priv.includes("wheel")) evidence.push(`member of ${priv.filter((x) => ["sudo", "admin", "wheel"].includes(x)).join(", ")} (these groups normally grant ALL in the default sudoers)`);
  if (priv.includes("docker") || priv.includes("lxd")) evidence.push(`member of ${priv.filter((x) => ["docker", "lxd"].includes(x)).join(", ")}: equivalent to root on this host`);
  let c: ReturnType<typeof classifySudoList>;
  if (l.ok) c = classifySudoList(l.out);
  else if (/password is required|a terminal is required/i.test(l.out)) c = { level: "unknown", commands: [], passwordless: false };
  else c = classifySudoList(l.out);
  if (c.level === "unknown" && priv.some((x) => ["sudo", "admin", "wheel"].includes(x))) evidence.push("the effective rules cannot be listed without a password: they are UNVERIFIED, but a sudo-group member usually has unrestricted rights");
  if (priv.some((x) => ["docker", "lxd"].includes(x)) && (c.level === "none" || c.level === "restricted")) evidence.push("container-runtime group membership bypasses the sudo policy");
  const verified = c.level === "restricted" && !priv.some((x) => ["sudo", "admin", "wheel", "docker", "lxd", "root", "disk"].includes(x));
  const rec: Record<PrivilegeLevel, string> = {
    root: "", none: "The deploy user has no sudo. Administrator steps in provision:plan must be run by an administrator.",
    restricted: verified ? "Explicit commands only: this is a least-privilege configuration." : "Explicit sudo rules exist, but group membership grants more: remove the user from the privileged group.",
    broad: "The rules allow wildcards, shells, editors or interpreters, each of which can be used to obtain root. Replace them with exact commands (nginx -t and nginx -s reload).",
    unrestricted: "UNRESTRICTED sudo: anything the agent user (or an attacker who controls it) runs can be root. This is not a narrow privilege policy. Use a dedicated deploy user with only `nginx -t` and `nginx -s reload`, and keep this account for administration.",
    unknown: "The effective sudo rules could not be listed non-interactively. Verify them manually (sudo -l as an administrator) before relying on any least-privilege claim.",
  };
  return { user: u.username, uid, groups, privilegedGroups: priv, level: c.level, passwordless: c.passwordless, commands: c.commands.slice(0, 20), evidence, narrowPolicyVerified: verified, recommendation: rec[c.level] };
}

// ================================================================== nginx discovery (read-only)
export interface NginxServer { names: string[]; listens: Array<{ address?: string; port: number; ssl: boolean }>; certificate?: string; certificateKeyPath?: string; locations: Array<{ path: string; proxyPass?: string }>; returns?: string[] }
export interface NginxUpstream { name: string; servers: string[] }
export interface NginxFile {
  path: string; kind: "main" | "sites-available" | "sites-enabled" | "conf.d" | "http.d" | "pso.d" | "other";
  symlinkTarget?: string; enabled: boolean; effective: boolean; managedBy: "pso" | "external"; app?: string; release?: string;
  size: number; sha256: string; servers: NginxServer[]; upstreams: NginxUpstream[];
}
const stripComments = (t: string): string => t.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
/** Minimal structural parse of nginx text: enough to show servers, listens, certificates, locations and upstreams. */
export function parseNginx(text: string): { servers: NginxServer[]; upstreams: NginxUpstream[] } {
  const t = stripComments(text); const servers: NginxServer[] = []; const upstreams: NginxUpstream[] = [];
  const block = (from: number): { body: string; end: number } => { let d = 0; for (let i = from; i < t.length; i++) { if (t[i] === "{") d++; else if (t[i] === "}") { d--; if (d === 0) return { body: t.slice(from + 1, i), end: i }; } } return { body: t.slice(from + 1), end: t.length }; };
  const re = /(^|[\s;}])(server|upstream\s+[A-Za-z0-9_.:-]+)\s*\{/g; let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const open = t.indexOf("{", m.index + m[1]!.length); const { body, end } = block(open); const head = m[2]!;
    if (head.startsWith("upstream")) upstreams.push({ name: head.split(/\s+/)[1]!, servers: [...body.matchAll(/(?:^|[;\s])server\s+([^;\s]+)[^;]*;/g)].map((x) => x[1]!) });
    else {
      const s: NginxServer = { names: [], listens: [], locations: [] };
      const flat = body.replace(/location\s+[^{]+\{[^}]*\}/g, "");
      for (const d of flat.matchAll(/(?:^|[;\s])(listen|server_name|ssl_certificate|ssl_certificate_key|return)\s+([^;]+);/g)) {
        const v = d[2]!.trim();
        if (d[1] === "listen") { const a = /^(?:\[([^\]]+)\]|([0-9.]+)):(\d+)|^(\d+)/.exec(v); const port = a ? Number(a[3] ?? a[4]) : NaN; if (!Number.isNaN(port)) s.listens.push({ ...(a?.[1] || a?.[2] ? { address: a[1] ?? a[2] } : {}), port, ssl: /\bssl\b/.test(v) }); }
        else if (d[1] === "server_name") s.names.push(...v.split(/\s+/));
        else if (d[1] === "ssl_certificate") s.certificate = v; else if (d[1] === "ssl_certificate_key") s.certificateKeyPath = v;
        else (s.returns ??= []).push(v);
      }
      for (const lm of body.matchAll(/location\s+(?:[=~*^]+\s+)?([^\s{]+)\s*\{([^}]*)\}/g)) s.locations.push({ path: lm[1]!, ...(/proxy_pass\s+([^;]+);/.exec(lm[2]!) ? { proxyPass: /proxy_pass\s+([^;]+);/.exec(lm[2]!)![1]!.trim() } : {}) });
      servers.push(s);
    }
    re.lastIndex = end;
  }
  return { servers, upstreams };
}
const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
function resolveIncludes(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file) || !existsSync(file)) return seen; seen.add(file);
  let t = ""; try { t = stripComments(readFileSync(file, "utf8")); } catch { return seen; }
  for (const m of t.matchAll(/(?:^|[;\s{}])include\s+([^;]+);/g)) {
    const pat = m[1]!.trim().replace(/^"|"$/g, ""); const abs = pat.startsWith("/") ? pat : posix.join(dirname(file), pat);
    if (!/[*?]/.test(abs)) { resolveIncludes(abs, seen); continue; }
    const dir = dirname(abs); const re = globToRe(basename(abs)); try { for (const f of readdirSync(dir)) if (re.test(f)) resolveIncludes(join(dir, f), seen); } catch { /* unreadable dir */ }
  }
  return seen;
}
export function discoverNginx(roots: { managedDir: string }, mainConf = "/etc/nginx/nginx.conf"): { mainConf: string; files: NginxFile[]; notes: string[] } {
  const notes: string[] = []; if (!existsSync(mainConf)) return { mainConf, files: [], notes: [`${mainConf} does not exist: nginx is not installed here or uses another layout`] };
  const effective = resolveIncludes(mainConf); const eff = new Set([...effective].map((p) => { try { return realpathSync(p); } catch { return p; } }));
  const dirs: Array<[string, NginxFile["kind"]]> = [["/etc/nginx/sites-available", "sites-available"], ["/etc/nginx/sites-enabled", "sites-enabled"], ["/etc/nginx/conf.d", "conf.d"], ["/etc/nginx/http.d", "http.d"], [roots.managedDir, "pso.d"], ["/etc/nginx/pso.d", "pso.d"]];
  const cands: Array<[string, NginxFile["kind"]]> = [[mainConf, "main"]]; const seenDir = new Set<string>();
  for (const [d, k] of dirs) { if (seenDir.has(d) || !existsSync(d)) continue; seenDir.add(d); try { for (const f of readdirSync(d)) cands.push([join(d, f), k]); } catch { notes.push(`${d} is not readable by the agent user`); } }
  for (const f of effective) if (!cands.some(([p]) => p === f)) cands.push([f, "other"]);
  const files: NginxFile[] = [];
  for (const [p, kind] of cands) {
    let st; try { st = lstatSync(p); } catch { continue; } if (st.isDirectory()) continue;
    const link = st.isSymbolicLink() ? (() => { try { return realpathSync(p); } catch { return "(dangling)"; } })() : undefined;
    let text = ""; try { text = readFileSync(p, "utf8"); } catch { notes.push(`${p} is not readable by the agent user`); }
    const marker = /^# Managed by PSO Web \(app=([a-z0-9-]+)\)/m.exec(text); const rel = /^# pso-release: (\S+)/m.exec(text);
    const real = (() => { try { return realpathSync(p); } catch { return p; } })();
    const parsed = parseNginx(text);
    files.push({ path: p, kind, ...(link ? { symlinkTarget: link } : {}), enabled: kind === "sites-available" ? [...cands].some(([q, k]) => k === "sites-enabled" && (() => { try { return realpathSync(q) === real; } catch { return false; } })()) : kind !== "main" || true, effective: eff.has(real) || kind === "main", managedBy: marker ? "pso" : "external", ...(marker ? { app: marker[1]! } : {}), ...(rel ? { release: rel[1]! } : {}), size: st.size, sha256: createHash("sha256").update(text).digest("hex"), servers: parsed.servers, upstreams: parsed.upstreams });
  }
  return { mainConf, files, notes };
}

/** Directive lint for an edit of a PSO-managed file. Refuses anything that could write files, load code, reach beyond the app or touch the management plane. */
export function lintNginx(text: string): string[] {
  const problems: string[] = []; const t = stripComments(text);
  let depth = 0; for (const ch of t) { if (ch === "{") depth++; else if (ch === "}") depth--; if (depth < 0) break; } if (depth !== 0) problems.push("braces are not balanced");
  const FORBIDDEN = /(^|[;\s{}])(include|load_module|lua_[a-z_]+|[a-z_]*_by_lua[a-z_]*|perl[a-z_]*|js_[a-z_]+|alias|root|access_log|error_log|client_body_temp_path|proxy_temp_path|fastcgi_[a-z_]*path|uwsgi_[a-z_]*path|scgi_[a-z_]*path|daemon|user|pid|env|worker_[a-z_]+|ssl_engine|auth_request|mirror|proxy_pass_request_headers\s+off|set_real_ip_from|resolver)\b/g;
  for (const m of t.matchAll(FORBIDDEN)) problems.push(`directive "${m[2]}" is not allowed in a PSO-managed file`);
  for (const m of t.matchAll(/proxy_pass\s+([^;]+);/g)) { const v = m[1]!.trim(); if (!/^http:\/\/(pso_[a-z0-9_]+|127\.0\.0\.1:\d{2,5})(\/[A-Za-z0-9._~\/-]*)?$/.test(v)) problems.push(`proxy_pass ${v} must target a PSO upstream (pso_*) or a loopback address`); }
  for (const m of t.matchAll(/ssl_certificate(?:_key)?\s+([^;]+);/g)) if (!/^\/(etc\/ssl|etc\/letsencrypt|etc\/nginx)\/[A-Za-z0-9_.\/-]+$/.test(m[1]!.trim()) || m[1]!.includes("..")) problems.push(`TLS file ${m[1]!.trim()} must be a plain path under /etc/ssl, /etc/letsencrypt or /etc/nginx`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) problems.push("control characters are not allowed");
  if (text.length > 64 * 1024) problems.push("file is larger than 64 KB");
  return [...new Set(problems)];
}
