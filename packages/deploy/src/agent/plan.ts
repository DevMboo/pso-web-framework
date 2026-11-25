import { canonical, randomToken, sha256 } from "../crypto.ts";
import { DEFAULT_PIPELINE, servicesOf, validateDeployment, validatePipeline, type DeploymentDecl, type PipelineDecl, type ServiceDecl, type StageDecl } from "../declare.ts";
import type { Inspection } from "./inspect.ts";
import { type Policy, policyHash } from "./state.ts";
import type { Resolved } from "./git.ts";

/**
 * Deployment planning: a pure function from (declaration, pipeline, policy, inspection of the target, current release, resolved source)
 * to an operational plan. The plan is what an operator reads and approves, and what the worker later executes; it is bound by hash to the
 * environment, the release, the policy and the material configuration, so an approval cannot be reused for something else.
 */
/**
 * Distinct outcomes, never merged: `passed` means the check RAN and succeeded. `disabled` = a pipeline setting switched it off; `skipped` = there was
 * nothing for it to do (for example no test steps declared); `unavailable` = it was supposed to run and could not (scanner missing, database unreachable);
 * `failed` = it ran and found a problem. Only `passed` is a pass.
 */
export type StageStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "disabled" | "unavailable" | "blocked" | "awaiting-approval" | "cancelled";

export interface PlannedStage { id: string; type: StageDecl["type"]; enabled: boolean; reason?: string; dependsOn: string[]; timeoutSeconds: number; onFailure: "fail" | "continue"; requiresApproval: boolean; command?: string[] }

export interface Plan {
  version: 1;
  /** who vouches for this release: integrity (the bytes are the ones named) and authenticity (a trusted signer named them) are reported separately */
  provenance: import("../signing.ts").Provenance;
  runtime: { supervisor: "process" | "systemd"; restart: "no" | "on-failure" };
  environmentId: string;
  environment: string;
  app: string;
  server: { user: string; os: string; arch: string };
  currentRelease: string | null;
  candidateRelease: string;
  source: { provider: "git"; url: string; ref: string; refType: Resolved["refType"]; commit: string } | { provider: "artifact"; sha256: string; size: number };
  strategy: { type: DeploymentDecl["strategy"]["type"]; proxy: "nginx" | "none"; rollback: boolean; autoRollback: boolean; drainSeconds: number; keep: number };
  services: Array<{ name: string; runtime: ServiceDecl["runtime"]; port: number | "auto"; instances: number; shutdownGraceSeconds: number; requires: ServiceDecl["requires"] | undefined; memoryMb: number; route: string | null }>;
  availability: { impact: "none expected" | "downtime"; summary: string; conditions: string[] };
  resources: { requiredMemoryMb: number; availableMemoryMb: number; requiredDiskMb: number; availableDiskMb: number };
  changes: { configuration: Array<{ kind: "nginx" | "migration" | "secrets"; target: string; action: string }>; infrastructure: string[] };
  stages: PlannedStage[];
  disabledChecks: Array<{ stage: string; reason: string }>;
  mandatory: string[];
  permissions: { minimumRole: "deployer"; privileged: string[] };
  rollback: { eligible: boolean; to: string | null; notes: string[]; /** what an application rollback can and cannot undo */ dataSafety: "code-only" | "schema-ahead" | "forward-only" };
  /** what the project says about running two releases side by side, and what that means for messaging, scheduling and connections */
  distributed: { overlap: boolean; notes: string[] };
  migrations: { mode: string; owner: string | null; destructive: boolean; notes: string[] };
  policyHash: string;
  declarationHash: string;
  warnings: string[];
  blockers: string[];
  approvalsRequired: number;
  hash: string;
  createdAt: string;
  id: string;
}

/** The checks that no pipeline configuration can turn off: they are part of the engine, not of the pipeline. */
export const MANDATORY_INVARIANTS: readonly string[] = [
  "authentication and authorization of the request",
  "server identity verification (pinned agent key)",
  "environment binding: the declaration's environment must be this server's environment",
  "deployment lock: one deployment per application at a time",
  "release transfer integrity: the commit or artifact checksum in the plan must match what was fetched",
  "valid activation configuration: the proxy configuration must pass `nginx -t` before it is applied",
  "candidate readiness: a candidate that is not ready never receives traffic (blue-green, rolling)",
  "safety-critical resource checks of the selected strategy (disk, memory headroom, free ports)",
  "process ownership: only processes this agent started, verified by identity token, are ever signalled",
  "systemd unit ownership: only units PSO created (name shape, marker and slot token) are ever started, stopped or removed",
  "required release signatures: where the SERVER's policy requires them, checked at planning and again at start, against the server's own trust store",
  "the server decides the runtime supervisor, the scan severity that blocks, and who may change trust: no declaration, pipeline, CLI option or Studio setting overrides them",
  "explicit authorization of destructive migrations, and refusal of overlap strategies for workloads declared unsafe in them",
  "a check that did not run is never reported as passed: it is disabled, skipped, unavailable or failed",
];

const DEFAULT_MEMORY_MB = 512;

export function resolvePipeline(decl: DeploymentDecl, supplied: PipelineDecl | undefined): { pipeline: PipelineDecl; errors: string[] } {
  const pipeline = supplied ?? DEFAULT_PIPELINE;
  const errors: string[] = [];
  if (decl.pipeline && supplied && supplied.name !== decl.pipeline) errors.push(`the deployment names pipeline "${decl.pipeline}" but "${supplied.name}" was supplied`);
  if (decl.pipeline && !supplied && decl.pipeline !== "default") errors.push(`the deployment names pipeline "${decl.pipeline}" but no such pipeline was supplied (create PIPELINE.pso.ts / deploy/${decl.pipeline}.pipeline.pso.ts)`);
  for (const d of validatePipeline(pipeline)) if (d.level === "error") errors.push(`${d.path}: ${d.message}`);
  const stages = pipeline.stages;
  const deployIdx = stages.findIndex((s) => s.type === "deploy");
  if (deployIdx === -1) errors.push("the pipeline has no deploy stage");
  else if (deployIdx !== stages.length - 1) errors.push("the deploy stage must be the last stage of the pipeline");
  return { pipeline, errors };
}

export interface PlanInput {
  /** absent = unsigned (callers written before release signing keep working) */
  provenance?: import("../signing.ts").Provenance;
  /** the last signed sequence this application deployed; a signed manifest must be newer */
  lastSignedSequence?: number;
  decl: DeploymentDecl;
  pipeline: PipelineDecl | undefined;
  policy: Policy;
  inspection: Inspection;
  environmentId: string;
  currentRelease: string | null;
  source: Plan["source"];
  declaredEnvironmentOfServer: string | undefined;
  hasPreviousRelease: boolean;
  releaseId: string;
  nginxConflicts: string[];
  nginxTarget: string | undefined;
  nginxAction: string | undefined;
  lockHeld: boolean;
  destructiveAcknowledged?: boolean;
}

export function buildPlan(i: PlanInput): Plan {
  const { decl, policy, inspection: insp } = i;
  const blockers: string[] = []; const warnings: string[] = [];
  for (const d of validateDeployment(decl)) (d.level === "error" ? blockers : warnings).push(`${d.path}: ${d.message}`);
  const services = servicesOf(decl);
  const { pipeline, errors } = resolvePipeline(decl, i.pipeline);
  blockers.push(...errors);

  if (i.declaredEnvironmentOfServer && i.declaredEnvironmentOfServer !== decl.environment) blockers.push(`this server is the "${i.declaredEnvironmentOfServer}" environment but the declaration targets "${decl.environment}": environments are never mixed`);
  if (policy.mode === "disabled") blockers.push("remote management is disabled on this server");
  if (!policy.allowedStrategies.includes(decl.strategy.type)) blockers.push(`the server policy does not allow the "${decl.strategy.type}" strategy (allowed: ${policy.allowedStrategies.join(", ")})`);
  // authenticity is the SERVER's policy: no declaration, pipeline stage, CLI option or Studio setting reaches this decision
  const prov: import("../signing.ts").Provenance = i.provenance ?? { integrity: "not-checked", authenticity: "unsigned", reasons: ["the release carries no signature"] };
  if (policy.requireSignedReleases && prov.authenticity !== "verified") blockers.push(`this environment requires releases signed by a trusted signer: ${prov.authenticity === "unsigned" ? "the release is unsigned" : `the signature was refused (${prov.authenticity}: ${prov.reasons[0] ?? ""})`}`);
  else if (prov.authenticity !== "verified" && prov.authenticity !== "unsigned") blockers.push(`a signature was presented but it is not acceptable (${prov.authenticity}: ${prov.reasons[0] ?? ""}); remove it or fix it: a bad signature is never ignored`);
  if (prov.authenticity === "verified" && typeof prov.sequence === "number" && prov.sequence <= (i.lastSignedSequence ?? 0)) blockers.push(`the signed manifest has sequence ${prov.sequence}, not newer than the last deployed signed release (${i.lastSignedSequence ?? 0}): a replay or a downgrade is refused (use release:rollback for an authorized return)`);
  if (prov.authenticity === "unsigned") warnings.push("the release is unsigned: its integrity is checked (immutable commit or checksum) but nobody vouches for who produced it");
  const nonPublic = (decl.proxy?.nginx?.domains ?? []).filter((x) => /\.(test|local|localhost|internal|example|invalid|lan)$/i.test(x));
  if (nonPublic.length) warnings.push(`domains ${nonPublic.join(", ")} are not public DNS names. PSO never edits /etc/hosts or DNS: if clients must resolve them, an administrator adds the entries (for example "127.0.0.1 ${nonPublic[0]}" on the clients' machines)`);
  const supervisor = decl.runtime?.supervisor ?? "process";
  if (!policy.supervisors.includes(supervisor)) blockers.push(`the server policy does not allow the "${supervisor}" runtime supervisor (allowed: ${policy.supervisors.join(", ")})`);
  if (supervisor === "systemd") {
    const sd = insp.systemd;
    if (!sd.available) blockers.push(`systemd is requested but unusable: ${sd.reason ?? "the user's systemd manager is not reachable"}`);
    else if (sd.linger === false) warnings.push(`systemd lingering is off for ${insp.user.name}: the services stop with the last login session and are not restarted at boot. An administrator must run: loginctl enable-linger ${insp.user.name}`);
    if (insp.user.root) blockers.push("the agent runs as root: PSO never manages services as root");
  }
  if (i.lockHeld) blockers.push("another deployment of this application is in progress (deployment lock held)");
  if (decl.source.provider === "artifact" && policy.requireArtifactChecksum && i.source.provider === "artifact" && !i.source.sha256) blockers.push("the server policy requires an artifact checksum");

  const proxy = decl.strategy.proxy ?? "none";
  if (proxy === "nginx") {
    if (!insp.tools.nginx.available) blockers.push("nginx is not installed on the server: it is required by the declared proxy (PSO does not install packages)");
    else if (insp.nginx.configValid === false) blockers.push("the current nginx configuration does not pass `nginx -t`; PSO will not modify a proxy it cannot validate");
    if (insp.nginx.configValid === undefined && insp.tools.nginx.available) blockers.push("nginx is installed but its configuration could not be tested by the agent user (check the sudo rule in provision:plan)");
    for (const c of i.nginxConflicts) blockers.push(`nginx: ${c}`);
    if (policy.nginxLayout === "pso.d" && !insp.nginx.managedDirWritable) blockers.push(`${policy.nginxManagedDir} is missing or not writable by the agent: an administrator must prepare it (see provision:plan)`);
  }
  if (decl.strategy.type === "recreate" && proxy === "none" && services.some((s) => typeof s.port !== "number")) blockers.push('recreate without a proxy needs a fixed port on every service (port: 8080): there is nothing to route to a dynamic port');

  // availability statement: never silently downgraded
  const t = decl.strategy.type;
  const conditions: string[] = [];
  let impact: Plan["availability"]["impact"] = "none expected"; let summary: string;
  if (t === "blue-green") { summary = "the active release keeps serving while the candidate is built, started and verified; traffic moves in one graceful nginx reload"; conditions.push("the application tolerates two versions running briefly (shared database schema compatible, no duplicate consumers/schedulers)", "enough memory and ports for two releases side by side", "nginx reload succeeds (validated first)", "long-lived connections (WebSocket) reconnect to the new release when their old connection closes"); }
  else if (t === "rolling") { summary = "instances are replaced one at a time behind nginx; with 2 or more instances there is always one serving"; conditions.push("every service runs 2+ instances", "old and new versions are compatible while mixed"); }
  else if (t === "static") { summary = "the new release is copied beside the active one (versioned and immutable) and activated by one atomic pointer write; browsers that already loaded the previous release keep working until they reload"; conditions.push("a microfrontend release is compatible with the active shell (contract and shared dependencies)", "no web-server restart: only a shell release can change the nginx file, and nginx is validated before it is reloaded"); }
  else { impact = "downtime"; summary = `the running release is stopped before the new one starts: expect downtime from the stop until the new release is ready (about the services' shutdown grace of up to ${Math.max(...services.map((s) => s.shutdownGraceSeconds ?? 30))}s plus start-up and readiness time)`; conditions.push("downtime acknowledged in the declaration"); }

  // resources
  const mem = services.reduce((n, s) => n + (s.runtime === "static" ? 0 : (s.resources?.memoryMb ?? DEFAULT_MEMORY_MB) * (s.instances ?? 1)), 0);
  const factor = t === "recreate" ? 1 : 2;
  const requiredMem = Math.round(mem * (t === "blue-green" || t === "rolling" ? 1 : 1)); // the candidate set; the active set is already resident
  const requiredDisk = services.reduce((n, s) => n + (s.resources?.diskMb ?? 500), 0);
  if (insp.memory.availableMb < requiredMem) blockers.push(`not enough free memory for the ${t === "recreate" ? "new" : "candidate"} release: need about ${requiredMem} MB, ${insp.memory.availableMb} MB available`);
  if (insp.disk.freeMb && insp.disk.freeMb < requiredDisk) blockers.push(`not enough free disk: need about ${requiredDisk} MB, ${insp.disk.freeMb} MB available`);
  void factor;

  // runtime requirements
  for (const s of services) {
    if (s.runtime === "node" && !insp.tools.node.available) blockers.push(`service ${s.name}: node is not available on the server`);
    if (s.runtime === "java" && !insp.tools.java.available) blockers.push(`service ${s.name}: java is not available on the server`);
  }
  if (decl.source.provider === "git" && !insp.tools.git.available) blockers.push("git is not installed on the server");

  // pipeline, with every disabled stage recorded (an omitted stage is never read as a pass)
  const stages: PlannedStage[] = []; const disabledChecks: Plan["disabledChecks"] = [];
  const known = new Set(["integrity", "compatibility", "security", "tests", "resources", "build", "health", "deploy"]);
  for (const s of pipeline.stages) {
    const id = s.id ?? s.type;
    const whenOk = !s.when?.environments || s.when.environments.includes(decl.environment);
    const enabled = s.enabled !== false && whenOk;
    const reason = !enabled ? (s.enabled === false ? `disabled in pipeline "${pipeline.name}"` : `not applicable to the ${decl.environment} environment`) : undefined;
    if (!enabled) disabledChecks.push({ stage: id, reason: reason! });
    if (s.type === "custom" && enabled) {
      if (!policy.allowCustomStages) blockers.push(`custom stage "${id}": the server policy does not allow custom stages`);
      if (!s.command || !s.command.length) blockers.push(`custom stage "${id}" has no command`);
    }
    stages.push({ id, type: s.type, enabled, ...(reason ? { reason } : {}), dependsOn: s.dependsOn ?? [], timeoutSeconds: s.timeoutSeconds ?? (s.type === "build" ? 1800 : 600), onFailure: s.onFailure ?? "fail", requiresApproval: s.requiresApproval === true, ...(s.command ? { command: s.command } : {}) });
  }
  for (const k of known) if (!stages.some((s) => s.type === k)) { disabledChecks.push({ stage: k, reason: "not declared in the pipeline (an omitted stage is not a pass)" }); }
  if (disabledChecks.some((d) => d.stage === "security")) warnings.push("the security stage is disabled: dependencies are not scanned for known vulnerabilities in this deployment");
  if (i.source.provider === "artifact") warnings.push("artifact source: the checksum proves the bytes that arrived are the bytes that were sent (integrity), not who built them: that is authenticity, and it needs a signed release manifest (signer:generate, release:sign)");

  // migrations
  const mig = decl.migrations;
  const migNotes: string[] = [];
  const destructive = !!mig?.destructive;
  if (mig?.mode === "expand-contract") migNotes.push("expand-contract: the migration runs once, before the candidate starts, owned by one service; the previous release must keep working against the migrated schema");
  if (destructive && !(mig?.approvedDestructive || i.destructiveAcknowledged)) blockers.push("destructive migration declared but not approved (approvedDestructive: true in the declaration, which is then part of the approved plan)");
  if (destructive && !policy.allowDestructiveMigrations) blockers.push("the server policy does not allow destructive migrations");
  if (mig && mig.mode !== "none") migNotes.push("rolling back the application does NOT roll back the database");
  if (services.some((s) => s.consumes)) {
    for (const s of services) for (const [dep, want] of Object.entries(s.consumes ?? {})) {
      const p = services.find((x) => x.name === dep);
      if (!p) blockers.push(`service ${s.name} consumes "${dep}" which is not part of this deployment`);
      else if (p.contract && want.split(".")[0] !== p.contract.split(".")[0]) blockers.push(`contract incompatibility: ${s.name} needs ${dep} ${want} but this release provides ${p.contract}`);
    }
  }

  // ---- distributed workloads: two releases run side by side in blue-green and rolling. PSO refuses what the project itself says is unsafe there.
  const overlap = decl.strategy.type !== "recreate"; const distNotes: string[] = [];
  for (const s of services) {
    const w = s.workload; if (!w) continue;
    if (overlap && w.scheduledJobs === "singleton") blockers.push(`service ${s.name}: scheduled jobs without leader election would run twice while the old and new release overlap (${decl.strategy.type}). Make the jobs leader-elected (workload.scheduledJobs: "leader-elected") or use strategy "recreate" with downtimeAcknowledged`);
    if (overlap && w.orderedConsumption) blockers.push(`service ${s.name}: ordered consumption needs a single active consumer, but ${decl.strategy.type} runs two releases at once. Use strategy "recreate" with downtimeAcknowledged`);
    if (w.selfMigrates) {
      if (overlap && mig?.mode !== "expand-contract") blockers.push(`service ${s.name} applies its own migrations at start: in ${decl.strategy.type} that happens while the previous release is still serving. Declare migrations.mode "expand-contract" (additive changes only) to confirm the schema stays compatible, or use strategy "recreate"`);
      if (overlap && mig?.destructive) blockers.push(`service ${s.name} applies a destructive migration at start while the previous release is still serving: that breaks the running release. Use strategy "recreate" with downtimeAcknowledged`);
      distNotes.push(`${s.name} migrates its own schema when it starts (${overlap ? "before traffic moves, with the previous release still serving" : "after the previous release stopped"}); concurrent starts are serialized by the database migration lock of the migration tool, not by PSO`);
    }
    if (w.consumers?.length) distNotes.push(`${s.name} consumes from ${w.consumers.join(", ")}: delivery stays at-least-once. ${overlap ? "While the releases overlap both consume from the same subscription (the broker rebalances); handlers must be idempotent" : "Consumption pauses while the release is replaced; messages wait in the broker"}. PSO does not provide exactly-once delivery`);
    if (w.outbox) distNotes.push(`${s.name} publishes through a transactional outbox: during an overlap two relays may publish the same row; consumers must tolerate duplicates (the outbox guarantees no loss, not no repetition)`);
    if (w.channels) distNotes.push(`${s.name} holds channel/WebSocket connections: those on the previous release are closed when it stops after the ${decl.strategy.drainSeconds ?? 10}s drain; clients must reconnect`);
    if (w.scheduledJobs === "leader-elected" && overlap) distNotes.push(`${s.name} runs leader-elected jobs: the leader may move to the new release during the switch; a job in progress on the old release is finished or abandoned by its own shutdown logic`);
  }
  const dataSafety: Plan["rollback"]["dataSafety"] = destructive ? "forward-only" : mig && mig.mode !== "none" ? "schema-ahead" : "code-only";
  if (dataSafety === "forward-only") migNotes.push("this release includes a destructive migration: an application rollback restores the previous CODE but cannot restore the data it removed; treat this release as forward-only (restore from backup if it must be undone)");
  if (dataSafety === "schema-ahead") migNotes.push("an application rollback restores the previous code on a database that stays at the newer, additive schema: that is safe only because expand-contract promises the previous release tolerates it");
  const rollbackEligible = decl.strategy.rollback !== false && !!i.currentRelease && i.hasPreviousRelease !== false;
  const nconf: Plan["changes"]["configuration"] = [];
  if (proxy === "nginx" && i.nginxTarget) nconf.push({ kind: "nginx", target: i.nginxTarget, action: i.nginxAction ?? "update" });
  if (mig && mig.mode !== "none") nconf.push({ kind: "migration", target: mig.command?.join(" ") ?? "", action: destructive ? "run (destructive)" : "run (expand-contract)" });
  const secretNames = services.flatMap((s) => Object.values(s.secrets ?? {}));
  if (secretNames.length) nconf.push({ kind: "secrets", target: [...new Set(secretNames)].join(", "), action: "inject as environment of the services (never written to manifests or logs)" });

  const planBody = {
    version: 1 as const, provenance: prov, environmentId: i.environmentId, environment: decl.environment, app: decl.name,
    server: { user: insp.user.name, os: insp.os.distro ?? insp.os.platform, arch: insp.os.arch },
    currentRelease: i.currentRelease, candidateRelease: i.releaseId, source: i.source,
    runtime: { supervisor, restart: decl.runtime?.restart ?? "no" },
    strategy: { type: t, proxy, rollback: decl.strategy.rollback !== false, autoRollback: decl.strategy.autoRollback !== false, drainSeconds: decl.strategy.drainSeconds ?? 10, keep: Math.max(decl.strategy.retention?.keep ?? 5, policy.retentionMin) },
    services: services.map((s) => ({ name: s.name, runtime: s.runtime, port: s.port ?? "auto", instances: s.instances ?? 1, shutdownGraceSeconds: s.shutdownGraceSeconds ?? 30, requires: s.requires, memoryMb: s.resources?.memoryMb ?? DEFAULT_MEMORY_MB, route: s.route?.path ?? null })),
    availability: { impact, summary, conditions },
    resources: { requiredMemoryMb: requiredMem, availableMemoryMb: insp.memory.availableMb, requiredDiskMb: requiredDisk, availableDiskMb: insp.disk.freeMb },
    changes: { configuration: nconf, infrastructure: [...(decl.infrastructure?.requires ?? []).map((r) => `requires ${r} (PSO does not provision it; the application must find it)`)] },
    stages, disabledChecks, mandatory: [...MANDATORY_INVARIANTS],
    permissions: { minimumRole: "deployer" as const, privileged: proxy === "nginx" ? [`nginx -t and nginx -s reload (${policy.nginxPrivilege === "sudo" ? "through a narrowly scoped sudo rule" : "directly"})`] : [] },
    distributed: { overlap, notes: distNotes },
    rollback: { dataSafety, eligible: rollbackEligible, to: i.currentRelease, notes: [...(rollbackEligible ? [] : ["no previous release exists to roll back to, or rollback is disabled"]), ...(mig && mig.mode !== "none" ? ["database changes made by this release are not reverted by rollback"] : [])] },
    migrations: { mode: mig?.mode ?? "none", owner: mig?.owner ?? services[0]?.name ?? null, destructive, notes: migNotes },
    policyHash: policyHash(policy), declarationHash: sha256(canonical({ decl, pipeline })),
    warnings, blockers, approvalsRequired: policy.approvalsRequired,
  };
  const hash = sha256(canonical(planBody));
  return { ...planBody, hash, createdAt: new Date().toISOString(), id: `plan_${randomToken(8)}` };
}

/** Release identifiers are immutable and sortable: time, then the start of the commit or artifact checksum. */
export function newReleaseId(source: Plan["source"], now = new Date()): string {
  const t = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `r${t}-${(source.provider === "git" ? source.commit : source.sha256).slice(0, 8)}`;
}
