import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatDiagnostic, loadWorkspace, type WorkspaceConfig } from "@pso/core";
import { loadFrontends, validateEcosystem } from "@pso/frontend/node";
import { INFRA_DIR, INFRA_FILE, adopt, apply, checkAuthority, checkLeaf, paths, protectFile, type InfraContract } from "@pso/infra";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command } from "./commands.ts";
import { INFRA_HOOKS, engine, initContract } from "./commands-infra.ts";
import { applySpringSecurity, planSpringSecurity } from "./migrate-spring-security.ts";

/**
 * The official migration of a 0.1 workspace to 0.2.0. It ADDS the 0.2 infrastructure contract and adopts what already exists and is valid;
 * it never rewrites application code, declarations, DTOs, routes, security configuration, dispatch contracts or data:
 *
 *   1. pso.infra.json is created from the workspace (one local development environment; the identity provider the workspace already uses)
 *   2. a valid development TLS directory (tls/ from `pso tls:init --dev`) is ADOPTED: the authority and the certificates are copied into
 *      .infra/ and recorded as PSO-owned, so they are reused instead of regenerated (tls/ itself is left as it is: the 0.1 compose file uses it)
 *   3. the development identity key of `pso idp:dev` is adopted the same way (tokens keep verifying against the same key)
 *   4. .infra/ is excluded from version control, then the local environment is provisioned (only what is still missing is generated)
 *
 * Without --apply nothing is written: the report says exactly what would happen. Files the 0.1 tools generated (docker-compose.yml,
 * tls/, idp/) keep working with the 0.1 commands; they are reported, not removed.
 */
interface Step { id: string; action: string; detail: string; files?: string[] }

function inspect(root: string, ws: WorkspaceConfig, identityFlag?: string): { steps: Step[]; notes: string[]; blockers: string[]; contract: InfraContract; adopt: Array<{ id: string; from: string[]; to: string[]; kind: "ca" | "certificate" | "signing-key" }> } {
  const steps: Step[] = [], notes: string[] = [], blockers: string[] = [];
  const adoptions: Array<{ id: string; from: string[]; to: string[]; kind: "ca" | "certificate" | "signing-key" }> = [];
  if (existsSync(join(root, INFRA_FILE))) blockers.push(`${INFRA_FILE} already exists: this workspace has been migrated (use pso infra:plan)`);
  // the application itself must be valid before its infrastructure is derived from it
  const fe = ws.frontends?.length ? validateEcosystem(root, loadFrontends(root, ws.frontends)) : undefined;
  const feErrors = fe?.diagnostics.filter((d) => d.severity === "error") ?? [];
  if (feErrors.length) blockers.push(`the frontend declarations have errors (pso frontend:validate):\n${feErrors.slice(0, 5).map((d) => `    ${formatDiagnostic(d as never)}`).join("\n")}`);
  const idpDir = join(root, "idp");
  const idpCfg = existsSync(join(idpDir, "idp.json")) ? JSON.parse(readFileSync(join(idpDir, "idp.json"), "utf8")) as { kid?: string; issuer?: string } : undefined;
  const identity = identityFlag ?? (existsSync(join(root, "keycloak")) ? "keycloak" : idpCfg ? "pso-dev" : "none");
  const contract = initContract(ws, { identity, runtime: "process", users: [] });
  steps.push({ id: "contract", action: "create", detail: `${INFRA_FILE}: environment "local" (development, ${contract.environments["local"]!.domain}, runtime process), identity ${identity}${ws.frontends?.filter((f) => f.kind === "fei").length ? `, ${ws.frontends.filter((f) => f.kind === "fei").length} FEI(s) with derived hosts` : ""}` });
  if (existsSync(join(root, "keycloak"))) notes.push("keycloak/ exists: its realm file is yours and is not imported. PSO generates its own realm (one client per FEI, redirect URIs from the hosts) in .infra/identity/local/realm.json; compare and move users or roles into pso.infra.json (identity.users)");
  // TLS adoption: only a complete, valid development authority (with its key) and certificates it issued
  const tls = join(root, "tls");
  if (existsSync(join(tls, "ca.crt"))) {
    const ca = checkAuthority(join(tls, "ca.crt"), join(tls, "ca.key"));
    if (!ca.ok) notes.push(`tls/ca.crt is not adopted (${ca.problems.join("; ")}): the local environment gets a new development authority`);
    else {
      adoptions.push({ id: "ca", kind: "ca", from: ["tls/ca.crt", "tls/ca.key"], to: [`${paths.ca("local")}/ca.crt`, `${paths.ca("local")}/ca.key`] });
      steps.push({ id: "adopt:ca", action: "adopt", detail: `development authority tls/ca.crt (${String(ca.facts["fingerprint"]).slice(0, 23)}..., ${ca.facts["daysLeft"]} days left) is reused, not regenerated` });
      for (const d of readdirSync(tls, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
        if (!ws.services.some((s) => s.name === d) && d !== "idp" && d !== "keycloak") { notes.push(`tls/${d}/ is not a service of this workspace: not adopted`); continue; }
        const target = d === "keycloak" ? "idp" : d;
        const names = target === "idp" ? ["idp", "localhost"] : [d, "localhost"];
        const c = checkLeaf(join(tls, d, "tls.crt"), join(tls, d, "tls.key"), join(tls, "ca.crt"), names);
        if (!c.ok) { notes.push(`tls/${d}/ is not adopted (${c.problems.join("; ")}): it will be issued again`); continue; }
        adoptions.push({ id: `cert:${target}`, kind: "certificate", from: [`tls/${d}/tls.crt`, `tls/${d}/tls.key`, "tls/ca.crt"], to: [`${paths.certs("local", target)}/tls.crt`, `${paths.certs("local", target)}/tls.key`, `${paths.certs("local", target)}/ca.crt`] });
        steps.push({ id: `adopt:cert:${target}`, action: "adopt", detail: `certificate tls/${d}/ for ${target} (${c.facts["daysLeft"]} days left) is reused` });
      }
    }
  }
  if (idpCfg?.kid && existsSync(join(idpDir, "keys", `${idpCfg.kid}.private.pem`)) && identity === "pso-dev") {
    adoptions.push({ id: "identity:signing-key", kind: "signing-key", from: [`idp/keys/${idpCfg.kid}.private.pem`], to: [`${paths.identity("local")}/signing-key.pem`] });
    steps.push({ id: "adopt:identity", action: "adopt", detail: `development signing key idp/keys/${idpCfg.kid}.private.pem is reused (its issuer becomes https://auth.${contract.environments["local"]!.domain}:8443)` });
  }
  if (existsSync(join(root, "docker-compose.yml"))) notes.push("docker-compose.yml (pso docker:init) is kept and still works with `pso deploy --target compose`; the 0.2 topology is generated in .infra/docker/<env>/compose.yml and used by pso docker:*");
  steps.push({ id: "ignore", action: "update", detail: ".gitignore excludes .infra/ (keys, secrets, state, generated configuration)" });
  steps.push({ id: "provision", action: "apply", detail: "pso infra:apply --env local: only what is still missing is generated (development authority, certificates, secrets, nginx, compose, runtime configurations)" });
  return { steps, notes, blockers, contract, adopt: adoptions };
}

export const MIGRATE_WORKSPACE_COMMANDS: Record<string, Command> = {
  "workspace:migrate": {
    usage: "pso workspace:migrate [--apply] [--identity keycloak|pso-dev|none] [--json]",
    summary: "Migrate a workspace to 0.2.0: add pso.infra.json, adopt the existing development TLS authority, certificates and identity key (reused, not regenerated), provision the local environment, and add the PUBLIC rules that Spring services generated before 0.2.0 lack for routes the orchestrator declares public (with backups). Without --apply it only reports; application logic, declarations and data are never changed",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const idFlag = str(ctx.flags["identity"]);
      if (idFlag !== undefined && !["keycloak", "pso-dev", "none"].includes(idFlag)) throw new CliError(`Unknown --identity "${idFlag}"`, "Use keycloak, pso-dev or none");
      const migrated = existsSync(join(root, INFRA_FILE));
      const r = inspect(root, config, idFlag);
      // a workspace that already has the contract skips the infrastructure steps; the other steps (Spring security) still run
      const steps = migrated ? [] : r.steps;
      const notes = migrated ? [`${INFRA_FILE} exists: the infrastructure steps are done (pso infra:plan); only the remaining steps run`] : r.notes;
      const blockers = r.blockers.filter((b) => !b.startsWith(`${INFRA_FILE} already exists`));
      const spring = planSpringSecurity(root, config);
      const springRows = spring.findings.map((f) => `  ${f.kind === "add" ? "add     " : f.kind === "covered" ? "ok      " : "REVIEW  "} ${f.service}: ${f.method} ${f.route} -> ${f.detail}`);
      const review = spring.findings.filter((f) => f.kind === "conflict" || f.kind === "ambiguous" || f.kind === "unmapped" || f.kind === "exposed-extra");
      const report = { from: "0.1", to: "0.2.0", applied: false, alreadyMigrated: migrated, steps, notes, blockers, springSecurity: spring };
      const nothing = migrated && !spring.changes.length;
      if (blockers.length || ctx.flags["apply"] !== true || nothing) {
        emit(ctx, report, [`migration to 0.2.0 of "${config.name}"${ctx.flags["apply"] === true ? "" : " (inspection: nothing is written)"}`, ...steps.map((s, i) => `  ${i + 1}. ${s.action.padEnd(8)} ${s.detail}`), ...notes.map((n) => `  note: ${n}`),
          ...(spring.findings.length ? ["Spring security (routes the orchestrator declares public):", ...springRows] : ["Spring security: no public route is served by a Spring service"]),
          ...blockers.map((b) => `  BLOCKED: ${b}`), "",
          blockers.length ? "Fix the blockers, then run it again." : nothing ? "Nothing to migrate." : `Run with --apply to migrate.${review.length ? ` ${review.length} finding(s) need your decision and will not be changed automatically.` : ""}`].join("\n"));
        return blockers.length ? 1 : 0;
      }
      const out: Record<string, unknown> = { ...report, applied: true };
      if (!migrated) {
        writeFileSync(join(root, INFRA_FILE), JSON.stringify(r.contract, null, 2) + "\n");
        for (const a of r.adopt) a.from.forEach((src, i) => { const to = join(root, ...a.to[i]!.split("/")); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(root, ...src.split("/")), to); if (/\.key$|private\.pem$/.test(to)) protectFile(to); });
        adopt(root, "local", r.adopt.map((a) => ({ id: a.id, kind: a.kind, files: a.to, origin: `adopted from ${a.from[0]!.split("/").slice(0, -1).join("/")}/ by pso workspace:migrate (0.1 -> 0.2.0)` })));
        const res = engine(() => apply(root, { env: "local", hooks: INFRA_HOOKS, by: "pso workspace:migrate" }));
        out["provisioned"] = res.applied.filter((x) => x.result === "done").map((x) => x.id);
        out["reused"] = r.adopt.map((a) => a.id);
      }
      const backupDir = join(root, INFRA_DIR, "backups", `migrate-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`);
      const backups = applySpringSecurity(root, spring, backupDir);
      out["springBackups"] = backups.map((b) => b.slice(root.length + 1).split("\\").join("/"));
      out["springAdded"] = spring.changes.flatMap((c) => c.add.map((a) => `${c.service}: ${a.method} ${a.path}`));
      mkdirSync(join(root, INFRA_DIR), { recursive: true });
      writeFileSync(join(root, INFRA_DIR, "migration-0.2.0.json"), JSON.stringify({ at: new Date().toISOString(), ...out }, null, 2) + "\n");
      emit(ctx, out, [`migrated "${config.name}" to 0.2.0`,
        ...(migrated ? [] : [`  reused (not regenerated): ${(out["reused"] as string[]).join(", ") || "(nothing to adopt)"}`, `  provisioned: ${(out["provisioned"] as string[]).length} resource(s)`]),
        `  Spring PUBLIC rules added: ${(out["springAdded"] as string[]).join(", ") || "none needed"}${backups.length ? ` (backups in ${(out["springBackups"] as string[]).map((b) => b.split("/").slice(0, 3).join("/"))[0]})` : ""}`,
        ...review.map((f) => `  REVIEW ${f.service}: ${f.method} ${f.route}: ${f.detail}`),
        ...notes.map((n) => `  note: ${n}`), `  report: ${INFRA_DIR}/migration-0.2.0.json`, ...(backups.length ? ["next: rebuild and restart the changed services (pso docker:up --service <name> --no-deps --build)"] : []), "next: pso infra:status   pso docker:plan   pso dev"].join("\n"));
      return 0;
    },
  },
};
void loadWorkspace;
