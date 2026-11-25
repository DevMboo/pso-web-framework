import { createHash } from "node:crypto";

/**
 * Versioned releases of the management agent itself.
 *
 * The agent used to be one file that an upgrade overwrote, keeping a single ".prev" copy that the NEXT upgrade overwrote again, so a rollback
 * point could vanish silently. Now every build is kept as an immutable release identified by its version AND its checksum (two builds with the
 * same semantic version are different releases), the file the server runs is a symbolic link that is switched atomically, and a history
 * records who installed what, when, from which release.
 *
 *   <agent dir>/releases/<version>+<build>/pso-agent.mjs     immutable; its checksum is recorded and re-verified before it is activated again
 *   <agent dir>/releases/<version>+<build>/release.json      version, build, sha256, size, installedAt, installedBy, source, compatibility
 *   <agent dir>/releases/state.json                          the active release, the history (newest last) and the retention
 *   <agent dir>/bin/pso-agent.mjs                            a symbolic link to the active release, replaced by one atomic rename
 *
 * The agent's identity, clients, policy, credentials and deployments live in the agent's state directories, never inside a release: switching
 * releases cannot touch them. The program below runs ON THE SERVER with the node that is already there (the agent requires it), receives its
 * parameters as JSON and prints one JSON document. It never deletes the active release or the one it replaced.
 */
export const AGENT_RELEASE_SCRIPT = String.raw`
const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process"); const crypto = require("node:crypto");
const a = JSON.parse(process.env.AGENT_RELEASE_PARAMS || "{}"); const dir = a.dir;
const rel = path.join(dir, "releases"), bin = path.join(dir, "bin"), link = path.join(bin, "pso-agent.mjs"), stateFile = path.join(rel, "state.json");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const atomic = (f, v) => { const t = f + ".tmp-" + process.pid; fs.writeFileSync(t, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(t, f); };
const fail = (m) => { process.stdout.write(JSON.stringify({ error: m }) + "\n"); process.exit(3); };
const versionOf = (file) => { const r = cp.spawnSync(process.execPath, [file, "version"], { env: { ...process.env, PSO_AGENT_HOME: dir }, encoding: "utf8", timeout: 20000 }); if (r.status !== 0) return { error: (r.stderr || "").trim().split("\n").slice(-1)[0] || "exit " + r.status }; try { return JSON.parse(r.stdout.trim()); } catch { return { error: "the file did not answer the version command" }; } };
const infoOf = (id) => read(path.join(rel, id, "release.json"), undefined);
const state = () => read(stateFile, { schema: 1, active: null, history: [], retain: 5 });
const compat = (v) => ({ protocol: v.protocol ?? [1], agent: v.agent, minPolicyVersion: 1 });
function activateLink(id) {
  const target = path.join("..", "releases", id, "pso-agent.mjs");
  fs.mkdirSync(bin, { recursive: true });
  const t = link + ".new-" + process.pid; try { fs.unlinkSync(t); } catch {}
  fs.symlinkSync(target, t); fs.renameSync(t, link); // one atomic replacement: the server runs the old file or the new one, never a half-written one
}
function adoptLegacy(by) {
  let st; try { st = fs.lstatSync(link); } catch { return undefined; }
  if (st.isSymbolicLink()) return undefined;
  const digest = sha(link); const v = versionOf(link); if (v.error) fail("the installed agent does not answer the version command, so it cannot be adopted: " + v.error);
  const id = v.agent + "+" + digest.slice(0, 12); const d = path.join(rel, id);
  if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.copyFileSync(link, path.join(d, "pso-agent.mjs")); fs.chmodSync(path.join(d, "pso-agent.mjs"), 0o600); atomic(path.join(d, "release.json"), { id, version: v.agent, build: digest.slice(0, 12), sha256: digest, size: st.size, installedAt: new Date().toISOString(), installedBy: by, source: "adopted", note: "the file that was installed before releases were versioned", compat: compat(v) }); }
  const s = state(); s.active = id; s.history.push({ at: new Date().toISOString(), action: "adopt", release: id, by }); atomic(stateFile, s);
  activateLink(id); return id;
}
function prune(s) {
  const keep = new Set([s.active, ...s.history.slice().reverse().map((h) => h.release).filter(Boolean)].filter(Boolean));
  const ordered = fs.readdirSync(rel).filter((n) => fs.existsSync(path.join(rel, n, "release.json"))).map((n) => ({ n, t: infoOf(n)?.installedAt ?? "" })).sort((x, y) => (x.t < y.t ? 1 : -1));
  const protect = new Set([s.active]); const prevId = previousOf(s); if (prevId) protect.add(prevId);
  const kept = []; const removed = [];
  for (const o of ordered) { if (protect.has(o.n) || kept.length < (s.retain ?? 5)) kept.push(o.n); else { fs.rmSync(path.join(rel, o.n), { recursive: true, force: true }); removed.push(o.n); } }
  void keep; return { kept, removed };
}
function previousOf(s) { for (let i = s.history.length - 1; i >= 0; i--) { const h = s.history[i]; if (h.release === s.active) { return h.from && h.from !== s.active && fs.existsSync(path.join(rel, h.from)) ? h.from : undefined; } } return undefined; }
const list = () => { const s = state(); return { active: s.active, previous: previousOf(s) ?? null, retain: s.retain ?? 5, releases: fs.existsSync(rel) ? fs.readdirSync(rel).map(infoOf).filter(Boolean).sort((x, y) => (x.installedAt < y.installedAt ? 1 : -1)) : [], history: s.history.slice(-20) }; };

if (a.op === "list") {
  let legacy = false; try { legacy = !fs.lstatSync(link).isSymbolicLink(); } catch {}
  process.stdout.write(JSON.stringify({ layout: legacy ? "legacy" : "releases", ...list() }) + "\n"); process.exit(0);
}
fs.mkdirSync(rel, { recursive: true, mode: 0o700 });
if (a.op === "install") {
  const file = a.file; if (!fs.existsSync(file)) fail("the uploaded agent file is missing");
  const digest = sha(file); if (digest !== a.sha256) { fs.rmSync(file, { force: true }); fail("checksum mismatch: the running agent was not changed"); }
  adoptLegacy(a.by);
  const v = versionOf(file); if (v.error) { fs.rmSync(file, { force: true }); fail("the new agent did not start (" + v.error + "): the running agent was not changed"); }
  const id = v.agent + "+" + digest.slice(0, 12); const d = path.join(rel, id);
  const s = state(); if (a.retain) s.retain = a.retain;
  const from = s.active;
  if (fs.existsSync(d)) { if (sha(path.join(d, "pso-agent.mjs")) !== digest) fail("a release with this id exists with different content: refusing to continue"); fs.rmSync(file, { force: true }); }
  else { const t = d + ".tmp-" + process.pid; fs.mkdirSync(t, { recursive: true, mode: 0o700 }); fs.renameSync(file, path.join(t, "pso-agent.mjs")); fs.chmodSync(path.join(t, "pso-agent.mjs"), 0o600); atomic(path.join(t, "release.json"), { id, version: v.agent, build: digest.slice(0, 12), sha256: digest, size: fs.statSync(path.join(t, "pso-agent.mjs")).size, installedAt: new Date().toISOString(), installedBy: a.by, source: a.source || "upgrade", compat: compat(v) }); fs.renameSync(t, d); }
  if (from === id) { process.stdout.write(JSON.stringify({ changed: false, from, to: id, ...list() }) + "\n"); process.exit(0); }
  s.active = id; s.history.push({ at: new Date().toISOString(), action: a.source === "install" ? "install" : "upgrade", release: id, from, by: a.by }); atomic(stateFile, s);
  activateLink(id); const p = prune(s);
  process.stdout.write(JSON.stringify({ changed: true, from: from ?? null, to: id, pruned: p.removed, ...list() }) + "\n"); process.exit(0);
}
if (a.op === "rollback") {
  const s = state(); if (!s.active) fail("no active release is recorded");
  const to = a.to || previousOf(s); if (!to) fail("there is no previous release to return to");
  if (to === s.active) fail("that release is already the active one");
  const info = infoOf(to); if (!info) fail("unknown release " + to);
  const f = path.join(rel, to, "pso-agent.mjs"); if (!fs.existsSync(f)) fail("the files of release " + to + " are gone");
  if (sha(f) !== info.sha256) fail("release " + to + " no longer matches its recorded checksum: it will not be activated");
  const v = versionOf(f); if (v.error) fail("release " + to + " does not start (" + v.error + ")");
  const from = s.active; s.active = to; s.history.push({ at: new Date().toISOString(), action: "rollback", release: to, from, by: a.by }); atomic(stateFile, s); activateLink(to);
  process.stdout.write(JSON.stringify({ changed: true, from, to, ...list() }) + "\n"); process.exit(0);
}
fail("unknown operation");
`;

export interface AgentReleaseInfo { id: string; version: string; build: string; sha256: string; size: number; installedAt: string; installedBy: string; source: "install" | "upgrade" | "adopted"; note?: string; compat: { protocol: number[]; agent: string; minPolicyVersion: number } }
export interface AgentReleaseHistoryEntry { at: string; action: "adopt" | "install" | "upgrade" | "rollback"; release: string; from?: string | null; by: string }
export interface AgentReleases { layout?: "legacy" | "releases"; active: string | null; previous: string | null; retain: number; releases: AgentReleaseInfo[]; history: AgentReleaseHistoryEntry[] }
export interface AgentReleaseChange extends AgentReleases { changed: boolean; from: string | null; to: string; pruned?: string[] }
export type RemoteShell = (command: string, input?: Buffer | string) => { status: number | null; stdout: string; stderr: string };

/** The identifier of a build: the semantic version plus the first 12 hex digits of the checksum, so two builds of one version stay distinguishable. */
export const agentReleaseId = (version: string, sha256: string): string => `${version}+${sha256.slice(0, 12)}`;
export const checksum = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
/** Runs the release program on the server. `dirExpr` is the agent directory as a shell expression ("$HOME/.pso-agent"). */
export function runReleaseOp<T>(run: RemoteShell, dirExpr: string, params: Record<string, unknown>): T {
  const cmd = `D=${dirExpr}; AGENT_RELEASE_PARAMS="$(printf '%s' ${q(JSON.stringify(params))} | sed "s#__DIR__#$D#g")" node -`;
  const r = run(cmd, AGENT_RELEASE_SCRIPT);
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let out: { error?: string } | undefined; try { out = JSON.parse(line) as { error?: string }; } catch { /* handled below */ }
  if (!out) throw new Error(`remote release step failed: ${r.stderr.trim().split("\n").slice(-2).join(" | ") || `exit ${r.status}`}`);
  if (out.error) throw new Error(out.error);
  return out as T;
}
/** Uploads a build to a temporary name inside the agent directory (never over a release). Returns the path in the form the release program takes ("__DIR__" is the agent directory). */
export function uploadBuild(run: RemoteShell, dirExpr: string, data: Buffer): string {
  const name = `upload-${checksum(data).slice(0, 12)}-${process.pid}.mjs`;
  const r = run(`mkdir -p ${dirExpr}/releases && chmod 700 ${dirExpr} ${dirExpr}/releases && cat > ${dirExpr}/releases/${name}`, data);
  if (r.status !== 0) throw new Error(`could not upload the agent: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
  return `__DIR__/releases/${name}`;
}
