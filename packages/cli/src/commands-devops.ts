import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hasErrors, formatDiagnostic, type ServiceDecl } from "@pso/core";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, validateAll, type Command, type Ctx } from "./commands.ts";
import { ciWorkflow, compose, dockerignore, envExample, nodeDockerfile, springDockerfile, type UpstreamTransport } from "./docker-templates.ts";
import { environmentFlag, securityCheck } from "./commands-security.ts";
import { TLS_DIR, checkTlsDir } from "./commands-tls.ts";
import { pomVersions } from "./pom-versions.ts";
import { npmInvocation } from "./proc.ts";
import { deployEnvironment, envDeployPlan, rollbackTo, currentRelease } from "./deploy-env.ts";
import { activate, remoteContext, remoteStatus } from "./remote-deploy.ts";
import { plan as infraPlan } from "@pso/infra";
import { INFRA_HOOKS, engine } from "./commands-infra.ts";
import { MAVEN_VENDOR_DIR, VENDOR_DIR, machineBoundDeps, psoVersionOfPom, vendorFramework, vendorMaven, type MavenVendorResult, type VendorResult } from "./vendor.ts";

const dry = (c: Ctx) => c.flags["dry-run"] === true;
const dir = (root: string, s: ServiceDecl) => join(root, ...s.path.split("/"));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const win = process.platform === "win32";

/** Runs a program with an argument array. npm and npx are batch wrappers on Windows: they are started explicitly, never through a shell string. */
function run(cmd: string, args: string[], cwd: string, inherit = false) {
  const inv = cmd === "npm" || cmd === "npx" ? npmInvocation(cmd, args) : { command: cmd, args };
  return spawnSync(inv.command, inv.args, { cwd, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", timeout: 900_000 });
}
function mvnw(cwd: string, args: string[], inherit = false) {
  return win ? run("cmd.exe", ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", ...args], cwd, inherit) : run("./mvnw", ["-B", "-ntp", ...args], cwd, inherit);
}
/**
 * On a POSIX host the generated compose file runs the containers as the user who generated it, by default: that is the owner of the
 * development TLS keys (`pso tls:init --dev`), which are readable by their owner only. PSO_CONTAINER_USER overrides it on another
 * machine. Windows has no uid: the images' own unprivileged users stay the default (Docker Desktop does not carry file modes).
 */
function containerUserDefault(): { containerUser?: string } {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  // root never becomes the default: a container that runs as root is refused here, whoever generated the file
  return uid !== undefined && gid !== undefined && uid !== 0 ? { containerUser: `${uid}:${gid}` } : {};
}
const pick = (ctx: Ctx, all: ServiceDecl[]): ServiceDecl[] => {
  const only = str(ctx.flags["service"]);
  if (!only) return all;
  const s = all.find((x) => x.name === only);
  if (!s) throw new CliError(`Unknown service "${only}"`, `Known: ${all.map((x) => x.name).join(", ")}`);
  return [s];
};

interface Artifact { service: string; runtime: string; file: string; sha256: string; bytes: number }
const ARTIFACTS = (root: string) => join(root, ".pso", "artifacts");

function dockerReady(): { ok: boolean; reason: string } {
  const v = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 });
  if (v.error) return { ok: false, reason: "docker is not installed or not on PATH" };
  if (v.status !== 0) return { ok: false, reason: "the Docker daemon is not running (start Docker Desktop / dockerd)" };
  return { ok: true, reason: "" };
}

function readArtifacts(root: string): Artifact[] {
  const f = join(ARTIFACTS(root), "manifest.json");
  if (!existsSync(f)) throw new CliError("No build artifacts found", "Run `pso build` first");
  return JSON.parse(readFileSync(f, "utf8")) as Artifact[];
}

const releaseId = (version: string, arts: Artifact[]) => `${version}+${createHash("sha256").update(arts.map((a) => `${a.service}:${a.sha256}`).sort().join("|")).digest("hex").slice(0, 8)}`;

function planFor(ctx: Ctx) {
  const { root, config } = requireWorkspace(ctx);
  const target = str(ctx.flags["target"]) ?? "native";
  if (target !== "native" && target !== "compose") throw new CliError(`Unknown target "${target}"`, "Supported: native, compose");
  if (target === "compose") {
    return { root, target, release: null as string | null, snapshots: [] as string[], steps: ["docker compose build", "docker compose up -d --wait"], files: [] as Artifact[], dir: null as string | null, previous: null as string | null, config };
  }
  const dest = str(ctx.flags["dir"]);
  if (!dest || !isAbsolute(resolve(dest))) throw new CliError("--dir <deployment directory> is required for the native target");
  const abs = resolve(dest);
  const arts = readArtifacts(root);
  for (const a of arts) {
    const f = join(ARTIFACTS(root), a.service, a.file);
    if (!existsSync(f) || sha256(f) !== a.sha256) throw new CliError(`Artifact ${a.service}/${a.file} is missing or does not match its recorded checksum`, "Run `pso build` again");
  }
  const version = str(ctx.flags["release"]) ?? "0.1.0";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new CliError(`Invalid --release "${version}" (semver MAJOR.MINOR.PATCH)`);
  // A release is made of fixed versions. The rule looks at the service's own version and at the PSO artifacts it builds against
  // (<pso.version>), not at the Spring Boot parent. Development deployments say so explicitly with --allow-snapshot, which is never
  // accepted for the production environment.
  const snapshots = arts.filter((a) => a.runtime === "spring-boot").flatMap((a) => {
    const svc = config.services.find((s) => s.name === a.service);
    const pom = svc ? join(dir(root, svc), "pom.xml") : undefined;
    return pom && existsSync(pom) ? pomVersions(readFileSync(pom, "utf8")).snapshots.map((why) => `${a.service}: ${why}`) : [];
  });
  const allowSnapshot = ctx.flags["allow-snapshot"] === true;
  const production = (process.env["PSO_ENV"] ?? process.env["NODE_ENV"]) === "production";
  if (allowSnapshot && production) throw new CliError("--allow-snapshot is not accepted for the production environment (PSO_ENV=production)", "A production release is built from fixed versions: see the hint of the SNAPSHOT refusal");
  if (snapshots.length && !allowSnapshot) throw new CliError(`Refusing to deploy a SNAPSHOT build:\n - ${snapshots.join("\n - ")}`, "A release uses fixed versions: build the PSO artifacts with a release version (node scripts/release-maven.mjs) and set <pso.version> and the service <version> to fixed versions. For a development deployment pass --allow-snapshot");
  const id = releaseId(version, arts);
  const cur = existsSync(join(abs, "current.json")) ? (JSON.parse(readFileSync(join(abs, "current.json"), "utf8")) as { release: string }) : null;
  return { root, target, release: id, snapshots: allowSnapshot ? snapshots : [], steps: [`copy ${arts.length} artifact(s) to ${join(abs, "releases", id)}`, "verify checksums", "switch current.json atomically", ...(ctx.flags["health-url"] ? ["verify health, roll back automatically on failure"] : [])], files: arts, dir: abs, previous: cur?.release ?? null, config };
}

async function healthOk(urls: string[], timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const results = await Promise.all(urls.map(async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(2000) }); await r.arrayBuffer(); return r.status === 200; } catch { return false; } }));
    if (results.every(Boolean)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const writeAtomic = (file: string, text: string) => { const t = `${file}.${process.pid}.tmp`; writeFileSync(t, text); renameSync(t, file); };

export const DEVOPS_COMMANDS: Record<string, Command> = {
  "docker:init": {
    usage: "pso docker:init [--transport tls|plaintext] [--vendor] [--maven-repo <dir>] [--dry-run] [--force] [--json]",
    summary: "Generate Dockerfiles, docker-compose.yml, .dockerignore, .env.example and a CI workflow (--transport: TLS between the orchestrator and the services, the default, with certificates from ./tls, or plaintext as an explicit choice; --vendor: carry the PSO packages inside each service, @pso/* tarballs for Node and com.pso Maven artifacts for Spring, so the build works on any machine)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (!config.services.length) throw new CliError("The workspace has no services");
      // each upstream's transport is taken from the orchestrator's own configuration: one that already declares TLS keeps it
      // TLS between the orchestrator and the services is what docker:init generates; plain HTTP is a choice that has to be made
      const requested = str(ctx.flags["transport"]) ?? "tls";
      if (requested !== "tls" && requested !== "plaintext") throw new CliError(`Unknown --transport "${requested}"`, "Supported: tls (default) and plaintext (explicit: unencrypted, the caller's token is not forwarded)");
      const mode: UpstreamTransport = requested;
      const orch = config.services.find((s) => s.role === "orchestrator");
      const transports: Record<string, UpstreamTransport> = {};
      if (orch) {
        let declared: Record<string, { tls?: Record<string, unknown> }> = {};
        try { declared = (JSON.parse(readFileSync(join(dir(root, orch), "pso.config.json"), "utf8").replace(/^\uFEFF/, "")) as { http?: { upstreams?: typeof declared } }).http?.upstreams ?? {}; } catch { /* no configuration file: every upstream is plain HTTP on the private network, stated explicitly */ }
        for (const s of config.services) if (s.role !== "orchestrator") { const t = declared[s.name]?.tls; transports[s.name] = t && (t["enabled"] === true || Object.keys(t).some((k) => k !== "enabled")) ? "configured" : mode; }
      }
      const files: Record<string, string> = { "docker-compose.yml": compose(config, transports, containerUserDefault()), ".env.example": envExample(config, transports), ".github/workflows/ci.yml": ciWorkflow(config) };
      // --vendor: the framework packages travel with the project (relative tarballs), so nothing points at this machine any more
      const vendored: VendorResult[] = [];
      const notPortable: Array<{ service: string; dependencies: string[] }> = [];
      const vendoredMaven: MavenVendorResult[] = [];
      const mavenNotPortable: Array<{ service: string; version: string }> = [];
      const mavenRepo = typeof ctx.flags["maven-repo"] === "string" ? ctx.flags["maven-repo"] : undefined;
      for (const s of config.services) {
        if (s.runtime === "spring-boot") {
          const hasVendor = existsSync(join(dir(root, s), ...MAVEN_VENDOR_DIR.split("/")));
          if (ctx.flags["vendor"] === true) vendoredMaven.push({ ...vendorMaven(dir(root, s), { dryRun: dry(ctx), ...(mavenRepo ? { mavenRepo } : {}) }), service: s.name });
          else if (!hasVendor) { const v = psoVersionOfPom(dir(root, s)); if (v) mavenNotPortable.push({ service: s.name, version: v }); }
          files[`${s.path}/Dockerfile`] = springDockerfile(ctx.flags["vendor"] === true || hasVendor);
          files[`${s.path}/.dockerignore`] = dockerignore();
          continue;
        }
        const isVendored = s.runtime === "node" && (ctx.flags["vendor"] === true || existsSync(join(dir(root, s), ...VENDOR_DIR.split("/"))));
        if (s.runtime === "node" && ctx.flags["vendor"] === true) vendored.push({ ...vendorFramework(dir(root, s), { dryRun: dry(ctx) }), service: s.name });
        else if (s.runtime === "node") { const bound = machineBoundDeps(dir(root, s)); if (bound.length) notPortable.push({ service: s.name, dependencies: bound.map(([n]) => n) }); }
        files[`${s.path}/Dockerfile`] = s.runtime === "node" ? nodeDockerfile(isVendored) : springDockerfile();
        files[`${s.path}/.dockerignore`] = dockerignore();
      }
      const res = writeFiles(root, files, { dryRun: dry(ctx), force: ctx.flags["force"] === true });
      // TLS mode: say now whether the certificates the compose file mounts are there and usable, not when a container fails to start
      const tlsHosts = Object.entries(transports).filter(([, t]) => t === "tls").map(([n]) => n);
      const tlsNotes: string[] = [];
      if (orch && tlsHosts.length) {
        const tlsDir = join(root, TLS_DIR);
        if (!existsSync(tlsDir)) tlsNotes.push(`NOTE       TLS: ${orch.name} -> ${tlsHosts.join(", ")} uses HTTPS with certificates from ./${TLS_DIR} (PSO_TLS_DIR), which does not exist yet. Development: \`pso tls:init --dev\`. Production: put your own certificates there, then \`pso tls:check\`. For plain HTTP instead (explicit, unencrypted): \`pso docker:init --transport plaintext --force\``);
        else {
          const problems = checkTlsDir(tlsDir, tlsHosts).findings;
          tlsNotes.push(...problems.map((f) => `${f.severity === "error" ? "WARNING   " : "NOTE      "} TLS: ${f.subject}: ${f.message}`));
          if (!problems.some((f) => f.severity === "error")) tlsNotes.push(`NOTE       TLS: ${orch.name} -> ${tlsHosts.join(", ")} over HTTPS, certificates from ./${TLS_DIR} verified (authority, validity, host names)`);
        }
      }
      // F-12: docker-compose.yml is the name of the generated deployment. A file with that name that docker:init did not write is the
      // developer's own (typically development infrastructure): it is never replaced, and the conflict says where such a file belongs.
      const composeConflict = res.some((r) => r.path === "docker-compose.yml" && r.action === "conflict");
      const foreignCompose = composeConflict && !/Generated by `pso docker:init`/.test(readFileSync(join(root, "docker-compose.yml"), "utf8"));
      const notes = [
        ...(foreignCompose ? ["NOTE       docker-compose.yml already exists and was not generated by `pso docker:init`: it is your own file and was NOT modified. Development infrastructure (a database, a broker) belongs in its own file, for example infra/postgres.compose.yml (docker compose -f infra/postgres.compose.yml up -d); move it there and run `pso docker:init` again. --force would replace it"] : []),
        ...vendored.flatMap((v) => [`${dry(ctx) ? "[dry-run] " : ""}vendored   ${v.service}: ${v.packages.map((p) => p.file.split("/").pop()).join(", ") || "(no @pso/* dependencies)"}`, ...v.changed.map((c) => `           ${c}`)]),
        // a missing artifact is named now, with the fix, instead of surfacing as an npm error inside a container build
        ...notPortable.map((n) => `WARNING    ${n.service}: ${n.dependencies.join(", ")} resolve to a path on THIS machine; the image build (and any other checkout) cannot find them. Run \`pso docker:init --vendor --force\`, or install them from your npm registry`),
        ...vendoredMaven.flatMap((v) => [`${dry(ctx) ? "[dry-run] " : ""}vendored   ${v.service}: com.pso ${v.version} (${v.artifacts.length} artifacts, ${v.files} files) -> ${MAVEN_VENDOR_DIR}`,
          ...(v.snapshot ? [`           NOTE: ${v.version} is a SNAPSHOT: right for development images. For a release, build fixed-version artifacts (node scripts/release-maven.mjs) and set <pso.version> to that version`] : [])]),
        ...tlsNotes,
        ...(orch ? Object.entries(transports).filter(([, t]) => t === "plaintext").map(([n]) => `NOTE       ${orch.name} -> ${n}: plain HTTP on the private compose network, authorized for this upstream only (PSO_UPSTREAM_${n.toUpperCase().replace(/-/g, "_")}_ALLOW_PLAINTEXT). Not encrypted; the caller's bearer token is not forwarded over it. See the header of docker-compose.yml for TLS`) : []),
        ...(orch && existsSync(join(dir(root, orch), "src", "main.ts")) && /process\.exit\(1\),\s*10_000/.test(readFileSync(join(dir(root, orch), "src", "main.ts"), "utf8")) ? [`WARNING    ${orch.name}: src/main.ts ends the process 10 s after a signal, whatever http.shutdown.graceMs says. Run \`pso migrate\` to see the change and \`pso migrate --apply\` to make it (or replace its .then block with ".then((app) => { shutdownOnSignals(app); })", exported by @pso/http)`] : []),
        ...mavenNotPortable.map((n) => `WARNING    ${n.service}: the com.pso:*:${n.version} artifacts exist only in the local Maven repository of THIS machine; the image build (and any other checkout or CI runner) cannot resolve them. Run \`pso docker:init --vendor --force\`, or publish them to a Maven repository your builds can reach`),
      ];
      emit(ctx, { dryRun: dry(ctx), files: res, vendored: vendored.map((v) => ({ service: v.service, packages: v.packages, changed: v.changed })), notPortable, vendoredMaven: vendoredMaven.map((v) => ({ service: v.service, version: v.version, snapshot: v.snapshot, artifacts: v.artifacts })), mavenNotPortable }, [...res.map((r) => `${dry(ctx) ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`), ...notes].join("\n"));
      return res.some((r) => r.action === "conflict") ? 1 : 0;
    },
  },

  "docker:build": {
    usage: "pso docker:build [--service name] [--json]",
    summary: "Build the images with docker compose (requires a running Docker daemon)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (!existsSync(join(root, "docker-compose.yml"))) throw new CliError("docker-compose.yml not found", "Run `pso docker:init` first");
      const d = dockerReady();
      if (!d.ok) throw new CliError(`Cannot build images: ${d.reason}`, "Nothing was built");
      const svc = str(ctx.flags["service"]);
      if (svc && !config.services.some((s) => s.name === svc)) throw new CliError(`Unknown service "${svc}"`);
      const env = { ...process.env };
      const r = spawnSync("docker", ["compose", "build", ...(svc ? [svc] : [])], { cwd: root, stdio: "inherit", env: { PSO_JWT_ISSUER: "build", PSO_JWT_AUDIENCE: "build", PSO_JWT_JWKS_URI: "https://build.invalid/jwks", ...env } });
      return r.status ?? 1;
    },
  },

  "build": {
    usage: "pso build [--service name] [--json]",
    summary: "Type-check Node services and package artifacts (npm pack / Spring Boot jar) with checksums into .pso/artifacts",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const v = validateAll(ctx);
      if (hasErrors(v.diagnostics)) { ctx.print(v.diagnostics.map(formatDiagnostic).join("\n")); throw new CliError("Validation failed; not building"); }
      const out = ARTIFACTS(root);
      const built: Artifact[] = [];
      const targets = pick(ctx, config.services);
      const prev = existsSync(join(out, "manifest.json")) ? (JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Artifact[]).filter((a) => !targets.some((t) => t.name === a.service)) : [];
      for (const s of targets) {
        const d = dir(root, s);
        const dst = join(out, s.name);
        mkdirSync(dst, { recursive: true });
        if (s.runtime === "node") {
          if (existsSync(join(d, "package.json")) && !existsSync(join(d, "node_modules"))) { const i = run("npm", ["install", "--no-audit", "--no-fund"], d); if (i.status !== 0) throw new CliError(`npm install failed in ${s.path}\n${i.stderr}`); }
          const tc = run("npm", ["run", "build", "--silent"], d); // compiles to dist/ (type errors fail the build)
          if (tc.error) throw new CliError(`Could not run the TypeScript compiler in ${s.path}: ${tc.error.message}`);
          if (tc.status !== 0) throw new CliError(`Type errors in ${s.path}:\n${tc.stdout}${tc.stderr}`);
          const p = run("npm", ["pack", "--pack-destination", dst, "--silent"], d);
          if (p.status !== 0) throw new CliError(`npm pack failed in ${s.path}\n${p.stderr}`);
          const file = readdirSync(dst).filter((f) => f.endsWith(".tgz")).sort().pop()!;
          built.push({ service: s.name, runtime: s.runtime, file, sha256: sha256(join(dst, file)), bytes: statSync(join(dst, file)).size });
        } else {
          ctx.print(`[${s.name}] mvnw package`);
          const r = mvnw(d, ["-DskipTests", "package"]);
          if (r.status !== 0) throw new CliError(`Maven build failed in ${s.path}\n${(r.stdout + r.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 15).join("\n")}`);
          const jar = readdirSync(join(d, "target")).find((f) => f.endsWith(".jar") && !f.endsWith(".original"));
          if (!jar) throw new CliError(`No jar produced for ${s.name}`);
          copyFileSync(join(d, "target", jar), join(dst, jar));
          built.push({ service: s.name, runtime: s.runtime, file: jar, sha256: sha256(join(dst, jar)), bytes: statSync(join(dst, jar)).size });
        }
      }
      const all = [...prev, ...built].sort((a, b) => (a.service < b.service ? -1 : 1));
      writeFileSync(join(out, "manifest.json"), JSON.stringify(all, null, 2) + "\n");
      emit(ctx, { artifacts: built }, built.map((a) => `${a.service.padEnd(16)} ${a.file}  ${a.bytes} bytes  sha256:${a.sha256.slice(0, 12)}`).join("\n"));
      return 0;
    },
  },

  "test": {
    usage: "pso test [--service name] [--json]",
    summary: "Run each service's own tests (npm test / mvnw test); fails if any fail",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const rows: Array<{ service: string; status: "passed" | "failed" | "no-tests"; detail: string }> = [];
      for (const s of pick(ctx, config.services)) {
        const d = dir(root, s);
        if (s.runtime === "node") {
          const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { scripts?: Record<string, string> };
          if (!pkg.scripts?.["test"]) { rows.push({ service: s.name, status: "no-tests", detail: "no \"test\" script in package.json" }); continue; }
          const r = run("npm", ["test", "--silent"], d);
          rows.push({ service: s.name, status: r.status === 0 ? "passed" : "failed", detail: r.status === 0 ? "npm test" : (r.stdout + r.stderr).split("\n").slice(-8).join("\n") });
        } else {
          const r = mvnw(d, ["test"]);
          const n = [...(r.stdout ?? "").matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)/g)].pop();
          rows.push({ service: s.name, status: r.status === 0 ? "passed" : "failed", detail: n ? `${n[1]} tests, ${n[2]} failures, ${n[3]} errors` : (r.stdout + r.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n") });
        }
      }
      emit(ctx, rows, rows.map((r) => `${r.status.padEnd(9)} ${r.service.padEnd(16)} ${r.detail}`).join("\n"));
      return rows.some((r) => r.status === "failed") ? 1 : 0;
    },
  },

  "lint": {
    usage: "pso lint [--env development|test|staging|production] [--json]",
    summary: "Static checks: workspace validation, configuration, security check (for one environment, with the sources the application runs with in it) and TypeScript type-check",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const problems: string[] = [];
      const v = validateAll(ctx);
      problems.push(...v.diagnostics.filter((d) => d.severity === "error").map(formatDiagnostic));
      problems.push(...securityCheck(root, config, environmentFlag(ctx)).filter((f) => f.severity === "critical" || f.severity === "high").map((f) => `${f.id} ${f.resource}: ${f.message}`));
      for (const s of config.services.filter((x) => x.runtime === "node")) {
        const d = dir(root, s);
        if (!existsSync(join(d, "node_modules"))) { problems.push(`${s.name}: dependencies not installed, TypeScript check skipped (run npm install)`); continue; }
        const r = run("npx", ["tsc", "--noEmit"], d);
        if (r.status !== 0) problems.push(`${s.name}: type errors\n${r.stdout}`);
      }
      emit(ctx, { ok: problems.length === 0, problems }, problems.length ? problems.join("\n") + "\nFAILED" : "OK");
      return problems.length ? 1 : 0;
    },
  },

  "deploy:plan": {
    usage: "pso deploy:plan --target native --dir <path> [--release 1.0.0] [--health-url url] [--allow-snapshot] [--json] | --target compose [--json] | --env <name> [--json]",
    summary: "Show exactly what a deployment would change, without changing anything (--env: the 0.2 environment deployment of pso.infra.json)",
    run(ctx) {
      if (str(ctx.flags["env"]) !== undefined) { const { d } = envDeployPlan(requireWorkspace(ctx).root, str(ctx.flags["env"])!); emit(ctx, d, [`deployment of "${d.environment}" (${d.kind}) to ${d.target}`, ...d.steps.map((s, i) => `  ${i + 1}. ${s}`), ...d.prerequisites.map((x) => `  prerequisite: ${x}`), ...d.blockers.map((x) => `  BLOCKED: ${x}`), "", "Nothing has been changed."].join("\n")); return d.blockers.length ? 1 : 0; }
      const p = planFor(ctx);
      emit(ctx, { target: p.target, release: p.release, directory: p.dir, previous: p.previous, steps: p.steps, artifacts: p.files, ...(p.snapshots.length ? { developmentDeployment: true, snapshots: p.snapshots } : {}) }, [
        ...(p.snapshots.length ? ["DEVELOPMENT DEPLOYMENT (--allow-snapshot): not a release, it contains SNAPSHOT versions", ...p.snapshots.map((s) => `  - ${s}`)] : []),
        `target:   ${p.target}`, ...(p.release ? [`release:  ${p.release}`, `previous: ${p.previous ?? "(none: first release, rollback unavailable)"}`, `into:     ${p.dir}`] : []),
        "steps:", ...p.steps.map((s, i) => `  ${i + 1}. ${s}`), ...p.files.map((a) => `  artifact ${a.service}/${a.file} sha256:${a.sha256.slice(0, 12)}`),
        "", "Nothing has been changed. Run `pso deploy` with the same options and --yes to apply.",
      ].join("\n"));
      return 0;
    },
  },

  "deploy": {
    usage: "pso deploy --target native --dir <path> [--release 1.0.0] [--health-url url ...] [--health-timeout 30] [--allow-snapshot] --yes [--json] | --target compose --yes [--json] | --env <name> [--dry-run] [--timeout 300] [--yes] [--json]",
    summary: "Apply a deployment (requires --yes); verifies checksums and health, rolls back on failed verification. --env deploys an environment of pso.infra.json (Docker target: build, record, start, verify through the edge, automatic rollback; bundle target: a reviewable bundle for the operator); --dry-run only plans",
    async run(ctx) {
      if (str(ctx.flags["env"]) !== undefined) { if (ctx.flags["target"] !== undefined) throw new CliError("--env and --target are two kinds of deployment: use one"); return deployEnvironment(ctx); }
      const p = planFor(ctx);
      if (ctx.flags["yes"] !== true) { ctx.print("Deployment requires explicit authorization. Review `pso deploy:plan`, then re-run with --yes."); return 3; }
      if (p.target === "compose") {
        const d = dockerReady();
        if (!d.ok) throw new CliError(`Cannot deploy: ${d.reason}`, "Nothing was changed");
        for (const args of [["compose", "build"], ["compose", "up", "-d", "--wait"]]) { const r = spawnSync("docker", args, { cwd: p.root, stdio: "inherit" }); if (r.status !== 0) return r.status ?? 1; }
        return 0;
      }
      const relDir = join(p.dir!, "releases", p.release!);
      mkdirSync(relDir, { recursive: true });
      for (const a of p.files) {
        mkdirSync(join(relDir, a.service), { recursive: true });
        const to = join(relDir, a.service, a.file);
        copyFileSync(join(ARTIFACTS(p.root), a.service, a.file), to);
        if (sha256(to) !== a.sha256) throw new CliError(`Checksum mismatch after copying ${a.service}/${a.file}`, "The release was not activated");
      }
      writeFileSync(join(relDir, "release.json"), JSON.stringify({ release: p.release, artifacts: p.files }, null, 2) + "\n");
      const before = existsSync(join(p.dir!, "current.json")) ? readFileSync(join(p.dir!, "current.json"), "utf8") : null;
      writeAtomic(join(p.dir!, "current.json"), JSON.stringify({ release: p.release, previous: p.previous }, null, 2) + "\n");
      const urls = (str(ctx.flags["health-url"]) ?? "").split("\n").filter(Boolean);
      if (urls.length) {
        const ok = await healthOk(urls, Number(str(ctx.flags["health-timeout"]) ?? 30));
        if (!ok) {
          if (before) writeAtomic(join(p.dir!, "current.json"), before); else { try { (await import("node:fs")).rmSync(join(p.dir!, "current.json")); } catch { /* none */ } }
          throw new CliError(`Health verification failed; rolled back to ${p.previous ?? "(nothing active)"}`, "The new release remains in releases/ for inspection");
        }
      }
      emit(ctx, { activated: p.release, previous: p.previous }, `activated ${p.release}${p.previous ? ` (previous: ${p.previous})` : ""}${urls.length ? "; health verified" : ""}`);
      return 0;
    },
  },

  "rollback": {
    usage: "pso rollback --dir <path> --yes [--json] | --env <name> [--to <release>] --yes [--json]",
    summary: "Re-activate the previous release of a native deployment, or (--env) of an environment deployed to Docker",
    async run(ctx) {
      const envName = str(ctx.flags["env"]);
      if (envName !== undefined) {
        const { root } = requireWorkspace(ctx);
        const ip = engine(() => infraPlan(root, envName, INFRA_HOOKS));
        if (ip.topology.decl.deploy?.target === "ssh") {
          const rc = remoteContext(ip);
          const st = remoteStatus(rc, ip.topology);
          const idx = st.current ? st.releases.indexOf(st.current) : -1;
          const to = str(ctx.flags["to"]) ?? (idx > 0 ? st.releases[idx - 1] : undefined);
          if (!to) throw new CliError(`"${envName}" on ${rc.host.name} has no earlier release to start again`);
          if (ctx.flags["yes"] !== true) { ctx.print(`Would start release ${to} of "${envName}" on ${rc.host.name} again (currently ${st.current ?? "none"}). Volumes and databases are kept; database migrations are NOT reverted. Re-run with --yes.`); return 3; }
          await activate(rc, ip.topology, to, (l) => ctx.print(l));
          emit(ctx, { environment: envName, host: rc.host.name, activated: to, from: st.current }, `rolled back "${envName}" on ${rc.host.name}: ${st.current ?? "(none)"} -> ${to} (database migrations are not reverted)`);
          return 0;
        }
        const cur = currentRelease(root, envName);
        const to = str(ctx.flags["to"]) ?? cur?.previous ?? undefined;
        if (!to) throw new CliError(`"${envName}" has no previous release to roll back to`);
        if (ctx.flags["yes"] !== true) { ctx.print(`Would restore release ${to} of "${envName}" (currently ${cur?.release ?? "none"}). Re-run with --yes.`); return 3; }
        await rollbackTo(ctx, root, envName, to, cur?.release);
        emit(ctx, { environment: envName, activated: to, from: cur?.release ?? null }, `rolled back "${envName}": ${cur?.release ?? "(none)"} -> ${to}`);
        return 0;
      }
      const dest = str(ctx.flags["dir"]);
      if (!dest) throw new CliError("--dir <deployment directory> is required");
      const abs = resolve(dest);
      const f = join(abs, "current.json");
      if (!existsSync(f)) throw new CliError("No active release in that directory");
      const cur = JSON.parse(readFileSync(f, "utf8")) as { release: string; previous: string | null };
      if (!cur.previous) throw new CliError("No previous release to roll back to");
      if (!existsSync(join(abs, "releases", cur.previous, "release.json"))) throw new CliError(`Previous release ${cur.previous} is no longer on disk`);
      if (ctx.flags["yes"] !== true) { ctx.print(`Would activate ${cur.previous} (currently ${cur.release}). Re-run with --yes to apply.`); return 3; }
      writeAtomic(f, JSON.stringify({ release: cur.previous, previous: null, rolledBackFrom: cur.release }, null, 2) + "\n");
      emit(ctx, { activated: cur.previous, from: cur.release }, `rolled back: ${cur.release} -> ${cur.previous}`);
      return 0;
    },
  },
};
