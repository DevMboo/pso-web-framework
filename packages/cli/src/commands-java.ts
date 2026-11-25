import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSecurityConfig, SecurityConfigError } from "@pso/security";
import { CliError } from "./fsx.ts";
import { validateSpring, type Finding } from "./spring-config.ts";
import { emit, requireWorkspace, saveWorkspace, type Command } from "./commands.ts";
import { str } from "./args.ts";
import { bundledMavenRepository, newestBomVersion, psoJavaDir, psoJavaInstalled, psoJavaVersion } from "./specs.ts";
import { cpSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { renderTemplate } from "./templates.ts";
import { findJavaPackage } from "./generators.ts";
import { configurationSources, environmentFlag } from "./commands-security.ts";
import { effectiveProjectEnv } from "./project-env.ts";
import { LAYERED_JPA_YML, springStructure } from "./project-structure.ts";

const win = process.platform === "win32";

function mvnw(cwd: string, args: string[]) {
  return win
    ? spawnSync("cmd.exe", ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", ...args], { cwd, stdio: "inherit" })
    : spawnSync("./mvnw", ["-B", "-ntp", ...args], { cwd, stdio: "inherit" });
}

const DATA_STARTER = `    <dependency>
      <groupId>com.pso</groupId>
      <artifactId>pso-data-spring-boot-starter</artifactId>
    </dependency>
`;
const ZONKY_DEP = `    <dependency>
      <groupId>io.zonky.test</groupId>
      <artifactId>embedded-postgres</artifactId>
      <version>2.1.0</version>
      <scope>test</scope>
    </dependency>
`;
const H2_DEP = `    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <scope>runtime</scope>
    </dependency>
`;

/** Adds `block` to the top-level <dependencies> of a pom unless an artifact with the same id is already there. Returns null when nothing can be done safely. */
export function addPomDependency(pom: string, artifactId: string, block: string): { text: string; changed: boolean } | null {
  if (new RegExp(`<artifactId>${artifactId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</artifactId>`).test(pom.replace(/<profiles>[\s\S]*<\/profiles>/, ""))) return { text: pom, changed: false };
  const stripped = pom.replace(/<profiles>[\s\S]*<\/profiles>/, (m) => m.replace(/</g, "\u0001"));
  const at = stripped.lastIndexOf("</dependencies>", stripped.search(/<build>/) >= 0 ? stripped.search(/<build>/) : stripped.length);
  if (at < 0) return null;
  return { text: pom.slice(0, at) + block + pom.slice(at), changed: true };
}

/** Sets `provider:` under the `database:` key of the pso section. Returns null when the file does not have the expected shape (never guesses). */
export function setDatabaseProvider(yml: string, provider: string): { text: string; changed: boolean } | null {
  const re = /^(  database:[^\n]*\n    provider: )([A-Za-z]+)([^\n]*)$/m;
  const m = re.exec(yml);
  if (!m) return null;
  if (m[2] === provider) return { text: yml, changed: false };
  return { text: yml.replace(re, `$1${provider}$3`), changed: true };
}

const SEV: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export const JAVA_COMMANDS: Record<string, Command> = {
  "security:validate": {
    usage: "pso security:validate [--env development|test|staging|production] [--json]",
    summary: "Validate the security configuration of the orchestrator (security.authentication.*) and of every PSO Spring service (pso.security.*) before anything runs",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const env = environmentFlag(ctx);
      type Issue = { id: string; severity: string; message: string; remediation?: string };
      const sources = configurationSources(root, config, env);
      const rows: Array<{ target: string; kind: string; status: "valid" | "invalid"; issues: Issue[] }> = [];
      for (const s of config.services) {
        const dir = join(root, ...s.path.split("/"));
        if (s.role === "orchestrator" && s.runtime === "node") {
          try {
            // the orchestrator's own sources for this environment: its .env files (development) under the process environment
            loadSecurityConfig({ projectDir: dir, environment: env, env: effectiveProjectEnv(root, s, process.env, env).env });
            rows.push({ target: s.name, kind: "orchestrator", status: "valid", issues: [] });
          } catch (e) {
            const issues: Issue[] = e instanceof SecurityConfigError ? e.issues.map((i) => ({ id: i.code, severity: "high", message: i.message })) : [{ id: "PSO_SEC_ERROR", severity: "high", message: (e as Error).message }];
            rows.push({ target: s.name, kind: "orchestrator", status: "invalid", issues });
          }
        } else if (s.runtime === "spring-boot") {
          const findings: Finding[] = validateSpring(root, s);
          rows.push({ target: s.name, kind: "spring-service", status: findings.some((f) => SEV[f.severity]! >= 3) ? "invalid" : "valid", issues: findings.map((f) => ({ id: f.id, severity: f.severity, message: f.message, remediation: f.remediation })) });
        }
      }
      const issueLine = (i: Issue): string => `         ${i.severity.padEnd(8)} ${i.id}: ${i.message}` + (i.remediation ? `\n                  fix: ${i.remediation}` : "");
      const text = rows.map((r) => [`${r.status === "valid" ? "ok     " : "INVALID"} ${r.target} (${r.kind})`, ...r.issues.map(issueLine)].join("\n")).join("\n");
      emit(ctx, { environment: env, sources, targets: rows }, [`environment: ${env}`, ...sources.map((x) => `  ${x.service}: configuration from ${x.sources}`), text, "", "Static validation only: key providers (JWKS reachability) are checked when each service starts.",
        ...(env === "production" ? [] : [`This result is about "${env}"; validate production with --env production where the production variables are set.`])].join("\n"));
      return rows.some((r) => r.status === "invalid") ? 1 : 0;
    },
  },

  "java:install": {
    usage: "pso java:install [--from <maven-repository-dir>] [--dry-run] [--json]",
    summary: "Install the PSO Java artifacts (BOM, starters) into the local Maven repository so generated Spring services resolve them: built from the framework checkout, or copied from a Maven file repository of a release (--from, or the one shipped with an installed CLI) without any source",
    next: "`pso create service <name>`; a generated service resolves com.pso:* from the local Maven repository",
    run(ctx) {
      // 1. a release: prebuilt artifacts in a Maven file repository (no sources, no Maven build)
      const from = str(ctx.flags["from"]) ?? (psoJavaDir() ? undefined : bundledMavenRepository());
      if (from !== undefined) {
        const source = resolve(ctx.cwd, from);
        // an installed CLI needs exactly the release it is bound to; a framework checkout may install whatever release it is given
        const version = psoJavaDir() ? newestBomVersion(source) : (existsSync(join(source, "com", "pso", "pso-bom", psoJavaVersion(), `pso-bom-${psoJavaVersion()}.pom`)) ? psoJavaVersion() : undefined);
        if (!version) throw new CliError(psoJavaDir() ? `${source} is not a Maven repository with the PSO artifacts (com/pso/pso-bom/<version>/ was not found)` : `${source} does not carry com.pso:*:${psoJavaVersion()}, the PSO Java release this CLI generates services for`, "Pass the repository directory of the matching PSO release (scripts/release-maven.mjs writes <out>/repository)");
        const target = join(homedir(), ".m2", "repository", "com", "pso");
        const group = join(source, "com", "pso");
        const artifacts = readdirSync(group).filter((a) => statSync(join(group, a)).isDirectory()).sort();
        const dryRun = ctx.flags["dry-run"] === true;
        // bookkeeping of the source machine's repository is not part of an artifact
        const skip = (file: string): boolean => /(^|[\\/])(_remote\.repositories|resolver-status\.properties|[^\\/]*\.lastUpdated)$/.test(file);
        if (!dryRun) for (const a of artifacts) cpSync(join(group, a), join(target, a), { recursive: true, filter: (f) => !skip(f) });
        emit(ctx, { dryRun, version, from: source, artifacts, installed: dryRun ? false : psoJavaInstalled(version) }, `${dryRun ? "[dry-run] " : ""}installed com.pso:*:${version} (${artifacts.length} artifacts) from ${source} into ~/.m2${/-SNAPSHOT$/.test(version) ? "\nnote: this is a SNAPSHOT (a development build); a release uses a fixed version" : ""}`);
        return 0;
      }
      if (ctx.flags["dry-run"] === true) throw new CliError("--dry-run applies to --from (copying prebuilt artifacts)", "Building from the checkout runs Maven; there is nothing to preview");
      // 2. a framework checkout: build from the sources
      const dir = psoJavaDir();
      if (!dir) throw new CliError("No PSO Java artifacts to install: this CLI has neither the sources (pso-java/, a framework checkout) nor a Maven repository shipped with it", "Pass the Maven file repository of a PSO release: pso java:install --from <dir> (scripts/release-maven.mjs produces release-out/maven/repository)");
      ctx.print(`installing PSO Java ${psoJavaVersion()} from ${dir}`);
      // the starters are tested by pso-integration-tests: run `./mvnw test` inside pso-java/ for that
      const r = mvnw(dir, ["install", "-DskipTests"]);
      if (r.status !== 0) throw new CliError("Maven build of the PSO Java artifacts failed (see the output above)");
      emit(ctx, { version: psoJavaVersion(), installed: psoJavaInstalled(psoJavaVersion()) }, `installed com.pso:*:${psoJavaVersion()} into ~/.m2`);
      return 0;
    },
  },

  "database:enable": {
    usage: "pso database:enable <h2|postgresql> [--service <name>] [--dry-run] [--json]",
    summary: "Opt a Spring service into a database: adds the persistence starter and sets pso.database.provider (H2 only for the local profile)",
    run(ctx) {
      const provider = ctx.positionals[0];
      if (provider !== "h2" && provider !== "postgresql") throw new CliError(`Unknown database "${provider ?? ""}"`, "Supported: h2 (local development and tests only) and postgresql");
      const { root, config } = requireWorkspace(ctx);
      const springs = config.services.filter((s) => s.runtime === "spring-boot");
      const name = str(ctx.flags["service"]) ?? (springs.length === 1 ? springs[0]!.name : undefined);
      const svc = springs.find((s) => s.name === name);
      if (!svc) throw new CliError("Name the Spring service with --service", `Spring services: ${springs.map((s) => s.name).join(", ") || "(none)"}`);
      const dir = join(root, ...svc.path.split("/"));
      const dry = ctx.flags["dry-run"] === true;
      const changes: string[] = [];

      const pomFile = join(dir, "pom.xml");
      let pom = readFileSync(pomFile, "utf8");
      const data = addPomDependency(pom, "pso-data-spring-boot-starter", DATA_STARTER);
      if (!data) throw new CliError("pom.xml has an unexpected shape: add com.pso:pso-data-spring-boot-starter yourself");
      if (data.changed) changes.push("pom.xml: + pso-data-spring-boot-starter");
      pom = data.text;
      if (provider === "postgresql") {
        // tests must not depend on a PostgreSQL server: they run against a real embedded one (no Docker)
        const z = addPomDependency(pom, "embedded-postgres", ZONKY_DEP);
        if (!z) throw new CliError("pom.xml has an unexpected shape: add io.zonky.test:embedded-postgres (test) yourself");
        if (z.changed) changes.push("pom.xml: + embedded-postgres (test scope, for the service's own tests)");
        pom = z.text;
      }
      if (provider === "h2") {
        const h2 = addPomDependency(pom, "h2", H2_DEP);
        if (!h2) throw new CliError("pom.xml has an unexpected shape: add com.h2database:h2 (runtime) yourself");
        if (h2.changed) changes.push("pom.xml: + h2 (runtime)");
        pom = h2.text;
      }

      const files: Record<string, string> = {};
      const edits: Array<[string, string, string]> = [];
      if (provider === "postgresql") {
        const appYml = join(dir, "src/main/resources/application.yml");
        let yml = readFileSync(appYml, "utf8");
        const set = setDatabaseProvider(yml, "postgresql");
        if (!set) throw new CliError("application.yml has no pso.database.provider key in the standard place", "Set pso.database.provider: postgresql manually");
        if (set.changed) changes.push("application.yml: pso.database.provider = postgresql");
        yml = set.text;
        if (!/^  datasource:/m.test(yml)) {
          const ds = `  datasource:\n    url: \${DB_URL:jdbc:postgresql://localhost:5432/${svc.name.replace(/-/g, "_")}}\n    username: \${DB_USER:}\n    password: \${DB_PASSWORD:}\n  flyway:\n    enabled: true\n`;
          const idx = yml.search(/^server:/m);
          if (idx < 0) throw new CliError("application.yml has no server: section to anchor the datasource settings");
          yml = yml.slice(0, idx) + ds + "\n" + yml.slice(idx);
          changes.push("application.yml: + spring.datasource (DB_URL, DB_USER, DB_PASSWORD) and Flyway");
        }
        // a layered service gets what `pso create service` gives it: Hibernate validates the Flyway schema, never creates or updates it
        if (springStructure(dir).layout.structure === "layered" && !/^  jpa:/m.test(yml)) {
          const flyway = /^  flyway:\n    enabled: true\n/m.exec(yml);
          if (!flyway) throw new CliError("application.yml has no spring.flyway section to anchor the JPA settings", "Add spring.jpa.hibernate.ddl-auto: validate yourself");
          const at = flyway.index + flyway[0].length;
          yml = yml.slice(0, at) + LAYERED_JPA_YML + yml.slice(at);
          changes.push("application.yml: + spring.jpa (ddl-auto: validate, open-in-view off, UTC)");
        }
        edits.push([appYml, readFileSync(appYml, "utf8"), yml]);
        const pkg = findJavaPackage(dir);
        const testCfg = renderTemplate("service-spring-postgres", { pkg, pkgpath: pkg.split(".").join("/") }, (rel) => !rel.endsWith("TestDatabaseConfig.java"));
        for (const [rel, text] of Object.entries(testCfg)) { const target = join(dir, "src", "test", "java", ...rel.replace(/^src\/test\/java\//, "").split("/")); if (!existsSync(target)) { files[target] = text; changes.push(`${rel}: tests use an embedded PostgreSQL`); } }
        const mig = join(dir, "src/main/resources/db/migration");
        if (!existsSync(mig)) { files[join(mig, ".gitkeep")] = ""; changes.push("src/main/resources/db/migration/ (Flyway migrations go here)"); }
      } else {
        const local = join(dir, "src/main/resources/application-local.yml");
        if (!existsSync(local)) throw new CliError("application-local.yml not found", "H2 is enabled for the local profile only; create that file first");
        let yml = readFileSync(local, "utf8");
        if (!/^  database:/m.test(yml)) {
          yml = yml.replace(/\n*$/, "\n") + "  database:\n    provider: h2\n";
          if (!/^pso:/m.test(yml)) yml = yml.replace(/\n*$/, "\n") + "pso:\n  database:\n    provider: h2\n";
          changes.push("application-local.yml: pso.database.provider = h2 (in-memory, local profile only; prod and staging refuse H2)");
        }
        edits.push([local, readFileSync(local, "utf8"), yml]);
      }

      const wsChanged = provider === "postgresql" && svc.db !== "postgres";
      if (wsChanged) changes.push("pso.workspace.json: db = postgres");
      if (!dry) {
        if (pom !== readFileSync(pomFile, "utf8")) writeFileSync(pomFile, pom);
        for (const [f, before, after] of edits) if (before !== after) writeFileSync(f, after);
        for (const [f, c] of Object.entries(files)) { mkdirSync(join(f, ".."), { recursive: true }); if (!existsSync(f)) writeFileSync(f, c); }
        if (wsChanged) { svc.db = "postgres"; saveWorkspace(root, config); }
      }
      emit(ctx, { service: svc.name, provider, dryRun: dry, changes }, changes.length ? changes.map((c) => `${dry ? "[dry-run] " : ""}${c}`).join("\n") : `${svc.name} already uses ${provider}: nothing to change`);
      return 0;
    },
  },
};
