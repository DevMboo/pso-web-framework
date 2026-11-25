import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INFRA_DIR, apply, compose, composeTarget, dockerReady, plan, ps, readState, redact, sha256, validate, writeState, type Plan } from "@pso/infra";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Ctx } from "./commands.ts";
import { INFRA_HOOKS, engine, engineAsync } from "./commands-infra.ts";
import { activate, deployRemote, remoteContext, remoteLogs, remoteStatus, type RemoteContext } from "./remote-deploy.ts";

/**
 * Environment deployments (0.2.0): `pso deploy --env <name>`.
 *
 * A release of an environment is the set of service images plus the generated configuration the containers mount. It is recorded under
 * .infra/deploy/<env>/releases/<id>/ (image ids, copies of the non-sensitive configuration, checksums): key material and secrets are never
 * copied, they stay where the environment's providers keep them. Two targets:
 *   docker  the Docker Engine this machine talks to (the current context, or deploy.dockerContext): build, record, start, verify through
 *           the edge with full TLS verification, and roll back to the previous release automatically when verification fails
 *   bundle  a reviewable directory for an operator (compose file, nginx, realm, runtime configurations, image list, prerequisites, checksums)
 * `--dry-run` prints the plan only. Nothing is ever deployed without --yes.
 */
interface Release { id: string; environment: string; at: string; by: string; images: Record<string, string>; configs: Record<string, string>; previous: string | null }
const deployDir = (root: string, env: string) => join(root, INFRA_DIR, "deploy", env);
const readJson = <T>(f: string): T | undefined => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return undefined; } };
const current = (root: string, env: string) => readJson<{ release: string; previous: string | null }>(join(deployDir(root, env), "current.json"));
const imageId = (image: string): string | undefined => { const r = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? r.stdout.trim() : undefined; };
const configFiles = (p: Plan): string[] => p.resources.filter((r) => r.kind === "config" && !r.id.startsWith("env:") && r.id !== "hosts" && r.id !== "docker:compose-deps").map((r) => r.files[0]!.path);

export interface EnvDeployPlan { environment: string; kind: string; target: "docker" | "bundle" | "ssh"; host?: string; hostChecks?: Array<{ severity: string; check: string; message: string }>; steps: string[]; prerequisites: string[]; blockers: string[]; services: string[]; frontends: Array<{ name: string; url: string; published: boolean }>; previous: string | null }

export function envDeployPlan(root: string, envName: string): { p: Plan; d: EnvDeployPlan } {
  const p = engine(() => plan(root, envName, INFRA_HOOKS));
  const t = p.topology;
  const target = t.decl.deploy?.target ?? (t.kind === "development" ? "docker" : "bundle");
  const blockers: string[] = [], prerequisites: string[] = [];
  for (const r of p.resources) {
    if (r.status === "external-missing") blockers.push(`${r.id}: ${r.reasons.join("; ")}`);
    // with an SSH target, supplied certificates and secrets are verified ON the host (pso host:check) instead of being prerequisites
    if (r.status === "external-unverified" && target !== "ssh") prerequisites.push(`${r.id}: ${r.description} — ${r.reasons.join("; ")}`);
    if (r.status === "drifted") blockers.push(`${r.id}: ${r.files[0]?.path} was edited by hand (pso infra:repair --env ${t.env})`);
  }
  const frontends = t.frontends.map((f) => ({ name: f.name, url: f.url, published: existsSync(join(root, INFRA_DIR, "sites", t.env, f.name, "fei", "current.json")) }));
  for (const f of frontends.filter((x) => !x.published)) blockers.push(`${f.name} has no published release for "${t.env}" (pso frontend:build ${f.name} && pso frontend:publish ${f.name} --env ${t.env})`);
  if (t.kind !== "development") prerequisites.push(...t.publicHosts.map((h) => `DNS: ${h} must resolve to the deployment host (PSO does not create DNS records)`));
  const steps = [
    ...(p.summary.changes ? [`apply ${p.summary.changes} infrastructure change(s) (configuration only${t.kind === "development" ? ", development material" : ""})`] : []),
    `build ${t.services.length} service image(s): ${t.services.map((s) => `${t.project}-${s.name}:${t.env}`).join(", ")}`,
    "record the release: image ids and checksums of the generated configuration",
    ...(target === "docker" ? ["start the containers in dependency order and wait until every one is healthy", "verify through the edge: TLS, security headers, API readiness, identity provider", "on a failed verification: restore the previous release and start it again"]
      : target === "ssh" ? [`check the host ${t.decl.deploy?.connection} (Docker, Compose, disk, port ${t.httpsPort}, the operator's certificates and secret files)`, "lock the environment on the host (one deployment at a time)", "transfer the release (configuration and published sites, no key or secret) and verify every checksum on the host", "transfer only the images the host does not already have (docker save | docker load over SSH)", "start in dependency order on the host and wait for health (named volumes and databases are kept)", "verify through an SSH tunnel to the host's edge: TLS, headers, API readiness, identity provider", "activate the release, or start the previous one again when verification fails (database migrations are not reverted)"]
      : [`write a deployment bundle into ${INFRA_DIR}/deploy/${t.env}/bundles/<release>/ for the operator`]),
  ];
  return { p, d: { environment: t.env, kind: t.kind, target, ...(target === "ssh" ? { host: t.decl.deploy?.connection } : {}), steps, prerequisites, blockers, services: t.services.map((s) => s.name), frontends, previous: current(root, t.env)?.release ?? null } };
}

function planText(d: EnvDeployPlan): string {
  return [`deployment of "${d.environment}" (${d.kind}) to target ${d.target}${d.previous ? `, previous release ${d.previous}` : ", first release"}`, "steps:", ...d.steps.map((s, i) => `  ${i + 1}. ${s}`),
    ...(d.prerequisites.length ? ["prerequisites (verified on the target, not here):", ...d.prerequisites.map((x) => `  - ${x}`)] : []),
    ...(d.blockers.length ? ["BLOCKED:", ...d.blockers.map((x) => `  - ${x}`)] : [])].join("\n");
}

export async function deployEnvironment(ctx: Ctx): Promise<number> {
  const { root } = requireWorkspace(ctx);
  const envName = str(ctx.flags["env"])!;
  const { p, d } = envDeployPlan(root, envName);
  let rc: RemoteContext | undefined;
  if (d.target === "ssh") {
    ctx.print(`checking the host ${d.host} ...`);
    rc = remoteContext(p);
    d.hostChecks = rc.findings;
    for (const f of rc.findings.filter((x) => x.severity === "error")) d.blockers.push(`host ${f.check}: ${f.message}`);
    if (!d.steps.length) void 0;
    d.previous = remoteStatus(rc, p.topology).current;
  }
  if (ctx.flags["dry-run"] === true || ctx.flags["yes"] !== true) {
    if (d.hostChecks) for (const f of d.hostChecks) ctx.print(`  ${f.severity.toUpperCase().padEnd(7)} host ${f.check}: ${f.message}`);
    emit(ctx, { dryRun: true, ...d }, `${planText(d)}\n\nNothing was changed.${ctx.flags["dry-run"] === true ? "" : " Re-run with --yes to deploy."}`);
    return d.blockers.length ? 1 : ctx.flags["dry-run"] === true ? 0 : 3;
  }
  if (d.blockers.length) throw new CliError(`the deployment of "${envName}" is blocked:\n  - ${d.blockers.join("\n  - ")}`, "Nothing was changed");
  const t = p.topology;
  if (rc) {
    if (p.summary.changes) { const ar = engine(() => apply(root, { env: envName, hooks: INFRA_HOOKS, by: "pso deploy" })); ctx.print(`infrastructure: ${ar.applied.filter((a) => a.result === "done").length} change(s) applied (configuration only)`); }
    const fresh = engine(() => plan(root, envName, INFRA_HOOKS));
    const r = await deployRemote(root, fresh, rc, (l) => ctx.print(l), Number(str(ctx.flags["timeout"]) ?? 300));
    if (!r.activated) throw new CliError(`release ${r.release} failed verification on ${rc.host.name} and ${r.rolledBackTo} was started again`, `Volumes and databases were kept; database migrations are not reverted. Inspect: pso deploy:logs <service> --env ${envName}`);
    emit(ctx, { release: r.release, target: "ssh", host: rc.host.name, verified: true, probes: r.probes, transferredImages: r.transferred, reusedImages: r.reused }, [...r.probes.map((x) => `ok  ${x.name.padEnd(42)} ${x.detail}`), `images transferred: ${r.transferred.length ? r.transferred.join(", ") : "none (the host already had them)"}`, `release ${r.release} of "${envName}" is active on ${rc.host.name} and verified`].join("\n"));
    return 0;
  }
  const by = process.env["USERNAME"] ?? process.env["USER"] ?? "pso";
  if (p.summary.changes) { const r = engine(() => apply(root, { env: envName, hooks: INFRA_HOOKS, by: `pso deploy (${by})` })); ctx.print(`infrastructure: ${r.applied.filter((a) => a.result === "done").length} change(s) applied`); }
  const after = engine(() => plan(root, envName, INFRA_HOOKS));
  if (d.target === "docker") { const dr = dockerReady(); if (!dr.ok) throw new CliError(`Docker is not usable: ${dr.reason}`, "Nothing was deployed"); }
  const c = d.target === "docker" ? composeTarget(root, t) : undefined;
  if (c) {
    ctx.print("building images ...");
    const b = await compose(c, ["build", ...t.services.map((s) => s.name)], { onLine: (l) => ctx.print(`  ${redact(l)}`) });
    if (b !== 0) throw new CliError(`the image build failed (exit ${b})`, "Nothing was deployed");
  }
  const images: Record<string, string> = {};
  for (const s of t.services) { const img = `${t.project}-${s.name}:${t.env}`; const id = c ? imageId(img) : undefined; images[s.name] = id ?? `(build ${img} from ./${s.decl.path})`; }
  const configs: Record<string, string> = {};
  for (const f of configFiles(after)) { const x = join(root, ...f.split("/")); if (existsSync(x)) configs[f] = sha256(readFileSync(x)); }
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${createHash("sha256").update(JSON.stringify({ images, configs })).digest("hex").slice(0, 8)}`;
  const prev = current(root, envName);
  const relDir = join(deployDir(root, envName), "releases", id);
  for (const f of Object.keys(configs)) { const to = join(relDir, "config", ...f.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(root, ...f.split("/")), to); }
  const rel: Release = { id, environment: envName, at: new Date().toISOString(), by, images, configs, previous: prev?.release ?? null };
  mkdirSync(relDir, { recursive: true });
  writeFileSync(join(relDir, "release.json"), JSON.stringify(rel, null, 2) + "\n");
  if (c) for (const s of t.services) spawnSync("docker", ["tag", `${t.project}-${s.name}:${t.env}`, `${t.project}-${s.name}:${id}`], { stdio: "ignore", windowsHide: true });

  if (d.target === "bundle") {
    const bdir = join(deployDir(root, envName), "bundles", id);
    for (const f of Object.keys(configs)) { const to = join(bdir, ...f.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(root, ...f.split("/")), to); }
    writeFileSync(join(bdir, "MANIFEST.json"), JSON.stringify({ release: id, environment: envName, images, files: configs }, null, 2) + "\n");
    writeFileSync(join(bdir, "DEPLOY.md"), [`# Deployment bundle ${id} — environment ${envName} (${t.kind})`, "", "Generated by `pso deploy`. It contains configuration only: no key, certificate key or secret value.", "", "## Prerequisites on the target", ...d.prerequisites.map((x) => `- ${x}`), "", "## Images", ...Object.entries(images).map(([k, v]) => `- ${k}: ${v}`), "", "## Start", "", "```", `docker compose -f ${INFRA_DIR}/docker/${envName}/compose.yml --project-directory . -p ${t.project} up -d --wait`, "```", "", "Then verify from a machine that resolves the public hosts: `pso infra:validate --env " + envName + " --probe`.", ""].join("\n"));
    writeFileSync(join(deployDir(root, envName), "current.json"), JSON.stringify({ release: id, previous: prev?.release ?? null }, null, 2) + "\n");
    emit(ctx, { release: id, target: "bundle", bundle: bdir }, `release ${id} recorded; bundle written to ${bdir}\nNothing was started: the bundle is for the operator of "${envName}" (DEPLOY.md lists the prerequisites)`);
    return 0;
  }
  ctx.print(`starting release ${id} ...`);
  const timeout = Number(str(ctx.flags["timeout"]) ?? 300);
  const upCode = await compose(c!, ["up", "-d", "--wait", "--wait-timeout", String(timeout), "--remove-orphans"], { onLine: (l) => ctx.print(`  ${redact(l)}`) });
  const v = upCode === 0 ? await engineAsync(() => validate(root, { env: envName, probe: true, hooks: INFRA_HOOKS })) : undefined;
  const failedProbes = v ? v.probes.filter((x) => !x.ok) : [];
  if (upCode === 0 && failedProbes.length === 0) {
    writeFileSync(join(deployDir(root, envName), "current.json"), JSON.stringify({ release: id, previous: prev?.release ?? null }, null, 2) + "\n");
    emit(ctx, { release: id, target: "docker", verified: true, probes: v!.probes, containers: ps(c!) }, [...v!.probes.map((x) => `ok  ${x.name.padEnd(42)} ${x.detail}`), `release ${id} of "${envName}" is active and verified${prev ? ` (previous: ${prev.release})` : ""}`].join("\n"));
    return 0;
  }
  const why = upCode !== 0 ? `containers did not become healthy (exit ${upCode})` : failedProbes.map((x) => `${x.name}: ${x.detail}`).join("; ");
  if (!prev) throw new CliError(`release ${id} failed verification: ${why}`, "There is no previous release to roll back to; the containers were left running for inspection (pso docker:ps, pso docker:logs)");
  ctx.print(`verification failed (${why}): rolling back to ${prev.release} ...`);
  await rollbackTo(ctx, root, envName, prev.release, id);
  throw new CliError(`release ${id} failed verification and was rolled back to ${prev.release}: ${why}`, `The failed release stays recorded in ${INFRA_DIR}/deploy/${envName}/releases/${id}/ for inspection`);
}

/** Restores a recorded release: its configuration files (state updated, so they are not reported as drift) and its images, then starts it. */
export async function rollbackTo(ctx: Ctx, root: string, envName: string, releaseId: string, from?: string): Promise<void> {
  const relDir = join(deployDir(root, envName), "releases", releaseId);
  const rel = readJson<Release>(join(relDir, "release.json"));
  if (!rel) throw new CliError(`release ${releaseId} of "${envName}" is not recorded`);
  const p = engine(() => plan(root, envName, INFRA_HOOKS));
  const t = p.topology;
  const st = readState(root);
  for (const f of Object.keys(rel.configs)) {
    const src = join(relDir, "config", ...f.split("/"));
    if (!existsSync(src)) continue;
    copyFileSync(src, join(root, ...f.split("/")));
    for (const r of Object.values(st.environments[envName]?.resources ?? {})) if (r.files[f] !== undefined) r.files[f] = rel.configs[f]!;
  }
  writeState(root, st);
  for (const [svc, imgId] of Object.entries(rel.images)) if (/^sha256:/.test(imgId)) spawnSync("docker", ["tag", imgId, `${t.project}-${svc}:${t.env}`], { stdio: "ignore", windowsHide: true });
  const c = composeTarget(root, t);
  const code = await compose(c, ["up", "-d", "--wait", "--wait-timeout", "300", "--force-recreate", "--remove-orphans"], { onLine: (l) => ctx.print(`  ${l}`) });
  if (code !== 0) throw new CliError(`the rollback to ${releaseId} did not become healthy (exit ${code})`, "Inspect with pso docker:ps and pso docker:logs");
  writeFileSync(join(deployDir(root, envName), "current.json"), JSON.stringify({ release: releaseId, previous: null, rolledBackFrom: from ?? null }, null, 2) + "\n");
}

export function releasesOf(root: string, env: string): Array<{ id: string; at: string; active: boolean }> {
  const d = join(deployDir(root, env), "releases");
  const cur = current(root, env)?.release;
  return existsSync(d) ? readdirSync(d).sort().map((id) => ({ id, at: readJson<Release>(join(d, id, "release.json"))?.at ?? "", active: id === cur })) : [];
}
export const currentRelease = current;
