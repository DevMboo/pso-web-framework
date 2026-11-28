import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { INFRA_DIR, compose, composeTarget, edgeImage, ensureEdgeImage, probe, redact, withLockAsync, type Plan, type ProbeResult, type Topology } from "@pso/infra";
import { CliError } from "./fsx.ts";
import { RemoteHost, assertRemotePath, checkHost, inspectHost, q, type HostFacts, type HostFinding } from "./remote-host.ts";

/**
 * Remote deployment over SSH (0.2.0). One environment = one directory on the host (<root>/<compose project>) with immutable releases:
 *
 *   <root>/<project>/releases/<id>/      the configuration the containers mount (compose, nginx, realm, published sites) + MANIFEST.sha256
 *   <root>/<project>/current             symbolic link to the active release
 *   <root>/<project>/history.json        activations and rollbacks
 *   <root>/<project>/.deploy-lock/       held while a deployment runs (one at a time per environment)
 *
 * Images are built here and transferred over SSH (`docker save | docker load`), only when the host does not already have the same image
 * id, so the host needs no registry. Certificates and secrets never travel: they are supplied by the operator at the declared paths and
 * verified before anything changes. Named volumes (databases) belong to the Compose project and survive releases and rollbacks; database
 * migrations are NOT reverted by a rollback (Flyway migrations are forward-only).
 */
export interface RemoteContext { host: RemoteHost; root: string; dir: string; facts: HostFacts; findings: HostFinding[] }
const toPosix = (p: string) => p.split(sep).join("/");
const tarBin = (): string => (process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe") ? "C:\\Windows\\System32\\tar.exe" : "tar");

export function neededOnHost(p: Plan): { secrets: string[]; certificates: Array<{ name: string; names: string[]; client?: boolean }> } {
  const secrets = p.resources.filter((r) => r.kind === "secret").map((r) => r.id.slice(7));
  const certificates = p.resources.filter((r) => r.kind === "certificate").map((r) => { const facts = r.description; void facts; const name = r.id.slice(5); return { name, names: [] as string[], ...(name.endsWith("-client") ? { client: true } : {}) }; });
  // the names each certificate must carry are the same rule the engine applies locally
  const t = p.topology;
  for (const c of certificates) c.names = c.name === "edge" ? ["edge", ...t.publicHosts] : c.name === "idp" ? ["idp", ...(t.identity ? [t.identity.host] : [])] : c.name.endsWith("-client") ? [c.name.slice(0, -7)] : [c.name];
  return { secrets, certificates };
}

export function remoteContext(p: Plan): RemoteContext {
  const t = p.topology;
  const d = t.decl.deploy ?? {};
  if (d.target !== "ssh" || !d.connection) throw new CliError(`environment "${t.env}" is not deployed over SSH`, "Set deploy: { target: \"ssh\", connection: \"<name>\" } in pso.infra.json");
  const host = new RemoteHost(d.connection);
  const root = assertRemotePath(d.root ?? "/srv/pso", "deploy.root");
  const facts = inspectHost(host, root);
  const findings = checkHost(host, t, facts, neededOnHost(p));
  return { host, root, dir: `${root}/${t.project}`, facts, findings };
}

const sh = (rc: RemoteContext, cmd: string, input?: string | Buffer, timeout = 300_000) => rc.host.exec(cmd, input, timeout);

/** uid:gid that must read the mounted keys and secret files: their owner on the host. Root is refused (containers never run as root). */
export function containerUser(rc: RemoteContext, t: Topology): string {
  const dir = t.tlsSource === "external" ? t.decl.tls!.dir! : t.secretProvider === "file" ? t.decl.secrets!.dir! : undefined;
  const owner = dir ? sh(rc, `stat -c '%u:%g' ${q(dir.replace(/\/+$/, ""))} 2>/dev/null`).stdout.trim() : sh(rc, "echo $(id -u):$(id -g)").stdout.trim();
  if (!/^\d+:\d+$/.test(owner)) throw new CliError(`cannot determine the owner of ${dir ?? "the deploy user"} on ${rc.host.name}`);
  if (owner.startsWith("0:")) throw new CliError(`${dir} belongs to root on ${rc.host.name}: containers would have to run as root to read the keys`, "Give the certificates and secret files to an unprivileged user (for example the deploy user), readable by that user only");
  return owner;
}
/**
 * The identity of an image that is the same in every image store: its layers (diff ids). The `.Id` is not: a containerd store (Docker
 * Desktop) reports the manifest digest, the classic store of a Linux host the configuration digest.
 */
const LAYERS = "{{json .RootFS.Layers}}";
const imageId = (image: string): string | undefined => { const r = spawnSync("docker", ["image", "inspect", "--format", LAYERS, image], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? createHash("sha256").update(r.stdout.trim()).digest("hex") : undefined; };

/** The files of a release, assembled locally: configuration (no key, no secret) and the published sites, with their checksums. */
function assemble(root: string, p: Plan, staging: string): { files: number; sha: string } {
  const t = p.topology;
  const configs = p.resources.filter((r) => r.kind === "config" && !r.id.startsWith("env:") && r.id !== "hosts" && r.id !== "docker:compose-deps").map((r) => r.files[0]!.path);
  for (const f of configs) { const s = join(root, ...f.split("/")); if (existsSync(s)) { const d = join(staging, ...f.split("/")); mkdirSync(dirname(d), { recursive: true }); cpSync(s, d); } }
  for (const f of t.frontends) { const s = join(root, INFRA_DIR, "sites", t.env, f.name); if (existsSync(s)) cpSync(s, join(staging, INFRA_DIR, "sites", t.env, f.name), { recursive: true, filter: (x) => !/\.lock$|[\\/]\.lock[\\/]?/.test(x) }); }
  const lines: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const x = join(d, n); if (statSync(x).isDirectory()) walk(x); else lines.push(`${createHash("sha256").update(readFileSync(x)).digest("hex")}  ./${toPosix(relative(staging, x))}`); } };
  walk(staging);
  writeFileSync(join(staging, "MANIFEST.sha256"), lines.join("\n") + "\n");
  return { files: lines.length, sha: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

const composeCmd = (t: Topology, relDir: string, args: string) => `cd ${q(relDir)} && docker compose -f ${q(`.infra/docker/${t.env}/compose.yml`)} --project-directory . -p ${q(t.project)} ${args}`;

export interface RemoteDeployResult { release: string; activated: boolean; rolledBackTo?: string; probes: ProbeResult[]; transferred: string[]; reused: string[] }

/** Locks, transfers, verifies, starts, probes through a tunnel, then activates; a failed release is rolled back to the previous one. */
export async function deployRemote(root: string, p: Plan, rc: RemoteContext, log: (l: string) => void, timeoutSec = 300): Promise<RemoteDeployResult> {
  const t = p.topology;
  const blocking = rc.findings.filter((f) => f.severity === "error");
  if (blocking.length) throw new CliError(`the host ${rc.host.name} does not meet the prerequisites of "${t.env}":\n  - ${blocking.map((f) => `${f.check}: ${f.message}`).join("\n  - ")}`, "Nothing was changed on the host");
  return withLockAsync(root, `deploy ${t.env} to ${rc.host.name}`, async () => {
    // one deployment at a time per environment ON THE HOST (other machines may deploy too): an atomic mkdir is the lock
    const owner = `${process.env["USERNAME"] ?? process.env["USER"] ?? "pso"}@${process.env["COMPUTERNAME"] ?? "host"} ${new Date().toISOString()}`;
    const lk = sh(rc, `mkdir -p ${q(rc.dir)} && mkdir ${q(`${rc.dir}/.deploy-lock`)} 2>/dev/null && printf %s ${q(owner)} > ${q(`${rc.dir}/.deploy-lock/owner`)}`);
    if (lk.status !== 0) { const who = sh(rc, `cat ${q(`${rc.dir}/.deploy-lock/owner`)} 2>/dev/null`).stdout.trim(); throw new CliError(`another deployment of "${t.env}" is running on ${rc.host.name} (${who || "owner unknown"})`, `Wait for it. A lock left by an interrupted deployment is removed with: pso deploy:unlock --env ${t.env} --yes`); }
    try {
      const c = composeTarget(root, t);
      log(`building ${t.services.length} image(s) here ...`);
      const b = await compose(c, ["build", ...t.services.map((s) => s.name)], { onLine: (l) => log(`  ${redact(l)}`) });
      if (b !== 0) throw new CliError(`the image build failed (exit ${b})`, "Nothing was changed on the host");
      // the edge runs the framework's own image, built here from the installed release and transferred like the services' images
      await ensureEdgeImage(edgeImage().tag, (l) => log(redact(l)));
      const images = [...t.services.map((s) => `${t.project}-${s.name}:${t.env}`), edgeImage().tag, t.images.nginx, ...(t.services.some((s) => s.db) ? [t.images.postgres] : []), ...(t.identity?.provider === "keycloak" ? [t.images.keycloak] : [])];
      const ids: Record<string, string> = {};
      for (const i of images) { const id = imageId(i); if (!id) throw new CliError(`image ${i} is not available here`, `docker pull ${i}`); ids[i] = id; }
      const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 8)}`;
      const relDir = `${rc.dir}/releases/${id}`;
      const staging = mkdtempSync(join(tmpdir(), "pso-release-"));
      try {
        const m = assemble(root, p, staging);
        writeFileSync(join(staging, "release.json"), JSON.stringify({ release: id, environment: t.env, images: ids, manifest: m.sha }, null, 2) + "\n");
        log(`transferring release ${id} (${m.files} files) ...`);
        const tr = await rc.host.pipe([tarBin(), "-c", "-f", "-", "-C", staging, "."], `mkdir -p ${q(relDir)} && tar -x -f - -C ${q(relDir)}`);
        if (tr.code !== 0) throw new CliError(`the transfer failed: ${redact(tr.stderr)}`);
        const v = sh(rc, `cd ${q(relDir)} && sha256sum -c --quiet MANIFEST.sha256`);
        if (v.status !== 0) throw new CliError(`the release on the host does not match its checksums: ${v.stdout}${v.stderr}`, "It was not activated");
        log("integrity verified on the host (sha256 of every file)");
      } finally { rmSync(staging, { recursive: true, force: true }); }
      const transferred: string[] = [], reused: string[] = [];
      for (const [img, localId] of Object.entries(ids)) {
        const remoteLayers = sh(rc, `docker image inspect --format '${LAYERS}' ${q(img)} 2>/dev/null`).stdout.trim();
        if (remoteLayers && createHash("sha256").update(remoteLayers).digest("hex") === localId) { reused.push(img); continue; }
        log(`transferring image ${img} ...`);
        const r = await rc.host.pipe(["docker", "save", img], "docker load");
        if (r.code !== 0) throw new CliError(`image transfer failed for ${img}: ${redact(r.stderr)}`);
        transferred.push(img);
      }
      for (const s of t.services) sh(rc, `docker tag ${q(`${t.project}-${s.name}:${t.env}`)} ${q(`${t.project}-${s.name}:${id}`)}`);
      const runAs = containerUser(rc, t);
      sh(rc, `printf 'PSO_CONTAINER_USER=%s\\n' ${q(runAs)} > ${q(`${relDir}/.env`)}`);
      log(`containers run as ${runAs} (the owner of the operator's certificates and secret files)`);
      const previous = sh(rc, `basename "$(readlink ${q(`${rc.dir}/current`)})" 2>/dev/null`).stdout.trim() || null;
      // the edge configuration is tested by nginx on the host, with the release's own mounts (the operator's certificates), before anything
      // is started: a configuration nginx rejects never replaces the running release
      const nt = sh(rc, composeCmd(t, relDir, "run --rm --no-deps -T edge nginx -e stderr -t"), undefined, 300_000);
      if (nt.status !== 0) throw new CliError(`the edge configuration of release ${id} was rejected by nginx -t on ${rc.host.name}: ${redact((nt.stdout + nt.stderr).split(/\r?\n/).filter((l) => /emerg|alert|crit|error/i.test(l)).slice(-3).join(" | "))}`, previous ? `Release ${previous} keeps running unchanged` : "Nothing was started");
      log("edge configuration accepted by nginx -t on the host");
      log(`starting release ${id} on ${rc.host.name} ...`);
      const up = sh(rc, composeCmd(t, relDir, `up -d --wait --wait-timeout ${timeoutSec} --no-build --remove-orphans`), undefined, (timeoutSec + 120) * 1000);
      for (const l of (up.stdout + up.stderr).split(/\r?\n/).filter(Boolean).slice(-12)) log(`  ${redact(l)}`);
      const probes = up.status === 0 ? await probeRemote(root, p, rc) : [];
      const failed = up.status !== 0 ? `containers did not become healthy (exit ${up.status})` : probes.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join("; ");
      if (!failed) {
        sh(rc, `ln -sfn ${q(`releases/${id}`)} ${q(`${rc.dir}/current.tmp`)} && mv -Tf ${q(`${rc.dir}/current.tmp`)} ${q(`${rc.dir}/current`)}`);
        appendHistory(rc, { at: new Date().toISOString(), action: "deploy", release: id, previous, by: owner.split(" ")[0] });
        return { release: id, activated: true, probes, transferred, reused };
      }
      if (!previous) throw new CliError(`release ${id} failed: ${failed}`, `There is no previous release to roll back to; inspect it with pso deploy:logs <service> --env ${t.env}`);
      log(`release ${id} failed (${failed}): rolling back to ${previous} ...`);
      await activate(rc, t, previous, log, timeoutSec);
      appendHistory(rc, { at: new Date().toISOString(), action: "rollback", release: previous, previous: id, by: owner.split(" ")[0], reason: failed });
      return { release: id, activated: false, rolledBackTo: previous, probes, transferred, reused };
    } finally { sh(rc, `rm -rf ${q(`${rc.dir}/.deploy-lock`)}`); }
  });
}

/** Starts a recorded release again: its configuration and the images tagged with its id. Volumes are kept; migrations are not reverted. */
export async function activate(rc: RemoteContext, t: Topology, release: string, log: (l: string) => void, timeoutSec = 300): Promise<void> {
  if (!/^[0-9]{14}-[0-9a-f]{8}$/.test(release)) throw new CliError(`invalid release id "${release}"`);
  const relDir = `${rc.dir}/releases/${release}`;
  if (sh(rc, `test -f ${q(`${relDir}/release.json`)}`).status !== 0) throw new CliError(`release ${release} is not on ${rc.host.name}`);
  for (const s of t.services) sh(rc, `docker tag ${q(`${t.project}-${s.name}:${release}`)} ${q(`${t.project}-${s.name}:${t.env}`)}`);
  const up = sh(rc, composeCmd(t, relDir, `up -d --wait --wait-timeout ${timeoutSec} --no-build --force-recreate --remove-orphans`), undefined, (timeoutSec + 120) * 1000);
  for (const l of (up.stdout + up.stderr).split(/\r?\n/).filter(Boolean).slice(-8)) log(`  ${redact(l)}`);
  if (up.status !== 0) throw new CliError(`release ${release} did not become healthy again (exit ${up.status})`, "Inspect with pso deploy:status and pso deploy:logs");
  sh(rc, `ln -sfn ${q(`releases/${release}`)} ${q(`${rc.dir}/current.tmp`)} && mv -Tf ${q(`${rc.dir}/current.tmp`)} ${q(`${rc.dir}/current`)}`);
}

function appendHistory(rc: RemoteContext, entry: Record<string, unknown>): void {
  const cur = sh(rc, `cat ${q(`${rc.dir}/history.json`)} 2>/dev/null`).stdout;
  let h: unknown[] = []; try { h = JSON.parse(cur) as unknown[]; } catch { /* first entry */ }
  sh(rc, `cat > ${q(`${rc.dir}/history.json.tmp`)} && mv -f ${q(`${rc.dir}/history.json.tmp`)} ${q(`${rc.dir}/history.json`)}`, JSON.stringify([...h, entry].slice(-200), null, 2));
}

/** The environment's public checks, run from here through an SSH tunnel to the host's edge, with the operator's authority. */
export async function probeRemote(root: string, p: Plan, rc: RemoteContext): Promise<ProbeResult[]> {
  const t = p.topology;
  const ca = t.tlsSource === "external" ? sh(rc, `cat ${q(`${t.decl.tls!.dir!.replace(/\/+$/, "")}/ca.crt`)}`).stdout : undefined;
  const tunnel = rc.host.tunnel(t.httpsPort, t.httpsPort);
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const resolve = Object.fromEntries([...t.publicHosts, `pso-unknown-host.${t.domain}`].map((h) => [h, "127.0.0.1"]));
    return await probe(root, p, { ...(ca ? { ca } : {}), resolve });
  } finally { tunnel.close(); }
}

export function remoteStatus(rc: RemoteContext, t: Topology): { current: string | null; releases: string[]; history: unknown[]; containers: Array<Record<string, unknown>>; locked: string | null } {
  const r = sh(rc, `echo "C=$(basename "$(readlink ${q(`${rc.dir}/current`)})" 2>/dev/null)"; ls -1 ${q(`${rc.dir}/releases`)} 2>/dev/null | sed 's/^/R=/'; [ -d ${q(`${rc.dir}/.deploy-lock`)} ] && echo "L=$(cat ${q(`${rc.dir}/.deploy-lock/owner`)} 2>/dev/null)"; echo '---H'; cat ${q(`${rc.dir}/history.json`)} 2>/dev/null; echo; echo '---P'; docker compose -p ${q(t.project)} ps --all --format json 2>/dev/null`);
  const [head = "", rest = ""] = r.stdout.split("---H");
  const [hist = "", ps = ""] = rest.split("---P");
  const current = /C=(\S+)/.exec(head)?.[1] ?? null;
  let history: unknown[] = []; try { history = JSON.parse(hist.trim() || "[]") as unknown[]; } catch { /* none */ }
  const containers = ps.trim() ? (ps.trim().startsWith("[") ? JSON.parse(ps.trim()) as Array<Record<string, unknown>> : ps.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)) : [];
  return { current: current && current !== "." ? current : null, releases: [...head.matchAll(/^R=(\S+)$/gm)].map((m) => m[1]!), history, containers: containers.map((c) => ({ service: c["Service"], state: c["State"], health: c["Health"], status: c["Status"] })), locked: /L=(.*)/.exec(head)?.[1] ?? null };
}

export function remoteLogs(rc: RemoteContext, t: Topology, service: string, tail: number): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(service)) throw new CliError(`invalid service name "${service}"`);
  return redact(sh(rc, `docker compose -p ${q(t.project)} logs --no-color --tail ${Math.min(Math.max(tail, 1), 5000)} ${q(service)} 2>&1`).stdout);
}
