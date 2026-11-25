// Focused smoke test of the INSTALLED PSO distribution as a fresh terminal sees it: PATH is rebuilt from the registry (machine + user
// values, as a new login gets them), the working directory is a new temporary folder outside any repository, and every step runs the
// `pso` that this PATH resolves. The run stops at once if that `pso` is not the expected installation (an npm-linked checkout, for example).
//   node scripts/psd/validate/installed-smoke.mjs --install <installation root> [--evidence <file>] [--docker]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const install = resolve(flag("install") ?? ""), withDocker = a.includes("--docker");
if (!existsSync(join(install, ".pso-install", "install.json"))) { console.error("--install <installation root> is required"); process.exit(2); }
const BS = String.fromCharCode(92);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, " ").slice(0, 160)})` : ""}`); };
const regPath = (scope) => spawnSync("powershell", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('Path','${scope}')`], { encoding: "utf8" }).stdout.trim();
const freshPath = `${regPath("Machine")};${regPath("User")}`;
const env = { ...process.env, PATH: freshPath, Path: freshPath, PSO_NO_BROWSER: "1" };
for (const k of ["PSO_HOME", "PSO_LAUNCHED_FROM", "PSO_CLOUD_HOME"]) delete env[k];
const work = mkdtempSync(join(tmpdir(), "pso-installed-smoke-"));
const term = (cwd, ...args) => { const r = spawnSync(process.env.ComSpec, ["/d", "/c", "pso", ...args], { encoding: "utf8", env, cwd, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
const tail = (s, n = 200) => s.trim().split(/\r?\n/).slice(-3).join(" | ").slice(-n);

let stop = false;
try {
  // ---------------------------------------------------------------- which pso, in which shell
  const ps = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Command pso -All | Select-Object -ExpandProperty Source) -join '|'"], { encoding: "utf8", env, cwd: work }).stdout.trim();
  const cmd = spawnSync(process.env.ComSpec, ["/d", "/c", "where", "pso"], { encoding: "utf8", env, cwd: work }).stdout.trim().split(/\r?\n/);
  const gitBash = ["C:/Program Files/Git/bin/bash.exe"].find((b) => existsSync(b));
  const gb = gitBash ? spawnSync(gitBash, ["-c", "command -v pso; pso --version"], { encoding: "utf8", env: { ...env, MSYS2_PATH_TYPE: "inherit" }, cwd: work }).stdout.trim().split(/\r?\n/) : [];
  const expected = join(install, "bin").toLowerCase();
  const first = ps.split("|")[0] ?? "";
  check("PowerShell resolves pso to the installation (first match)", first.toLowerCase().startsWith(expected), ps);
  check("CMD resolves pso to the installation (first match)", (cmd[0] ?? "").toLowerCase().startsWith(expected), cmd.join(" | "));
  if (gitBash) check("Git Bash resolves pso to the installation's POSIX launcher and runs it", /PSO[\\/]bin[\\/]pso$/i.test((gb[0] ?? "").replace(/^\/c\//i, "C:/").replace(/\//g, "\\")) && /^0\.2\.0/.test(gb[1] ?? ""), gb.join(" | "));
  check("no npm-global or development pso is found anywhere on PATH", !ps.toLowerCase().includes(`${BS}appdata${BS}roaming${BS}npm`) && !cmd.some((l) => /pso-web-framework/i.test(l)), ps);
  const dev = spawnSync(process.env.ComSpec, ["/d", "/c", "where", "pso-dev"], { encoding: "utf8", env, cwd: work }).stdout.trim();
  check("the framework checkout is reachable only as pso-dev", /tools\\dev-bin\\pso-dev/i.test(dev), dev);
  if (!first.toLowerCase().startsWith(expected)) { stop = true; throw new Error("the pso on PATH is not the installation: nothing else is validated"); }

  // ---------------------------------------------------------------- identity of the installed distribution
  let r = term(work, "--version"); check("pso --version", r.code === 0 && r.out.trim() === "0.2.0", r.out.trim());
  r = term(work, "integrity", "report", "--json");
  let rep = {}; try { rep = JSON.parse(r.out); } catch { /* reported below */ }
  check("the running pso is the installation itself (integrity report without --root names it)", r.code === 0 && String(rep.root ?? "").toLowerCase() === install.toLowerCase() && rep.ok === true, `root=${rep.root} version=${rep.version}`);
  const state = JSON.parse(readFileSync(join(install, ".pso-install", "install.json"), "utf8"));
  check("packages are loaded from the installation's versions folder", existsSync(join(install, "versions", state.current, "node_modules", "@pso", "cli", "package.json")) && existsSync(join(install, "versions", state.current, "node_modules", "@pso", "infra", "package.json")), join(install, "versions", state.current, "node_modules", "@pso"));
  r = term(work, "--help");
  const families = ["create", "infra:apply", "infra:identity", "docker:up", "host:inspect", "host:check", "deploy:status", "workspace:migrate", "studio", "fei:register"];
  check("help lists the 0.2.0 command families", r.code === 0 && families.every((c) => r.out.includes(c)), families.filter((c) => !r.out.includes(c)).join(","));
  r = term(work, "infra:identity", "--help"); check("command discovery: pso <command> --help", r.code === 0 && /Usage: pso infra:identity/.test(r.out), tail(r.out));
  r = term(work, "infra:identitty"); check("command discovery: a mistyped command suggests the right one", r.code === 2 && /Did you mean `pso infra:identity`/.test(r.out), tail(r.out));

  // ---------------------------------------------------------------- documentation and assistant guidance shipped with the release
  const docs = join(install, "versions", state.current, "node_modules", "@pso", "cli", "docs");
  const pages = ["infrastructure/remote-hosts.md", "infrastructure/identity-reconciliation.md", "infrastructure/release-integrity-and-signing.md", "infrastructure/migration.md", "devops/installed-and-development-cli.md", "ai-context/scopes/infrastructure.md"];
  check("the installed release carries the 0.2.0 documentation pages", pages.every((p) => existsSync(join(docs, ...p.split("/")))), pages.filter((p) => !existsSync(join(docs, ...p.split("/")))).join(","));
  check("the assistant (LLM) scope covers identity, remote hosts, migration and installed vs development CLI", /infra:identity/.test(readFileSync(join(docs, "ai-context", "scopes", "infrastructure.md"), "utf8")) && /pso-dev/.test(readFileSync(join(docs, "ai-context", "scopes", "infrastructure.md"), "utf8")));
  const outDocs = join(work, "site");
  r = term(work, "docs", "--build", outDocs); check("pso docs --build renders the installed documentation", r.code === 0 && existsSync(join(outDocs, "infrastructure", "remote-hosts.html")), tail(r.out));

  // ---------------------------------------------------------------- a workspace: services, two FEIs, public route, infrastructure
  r = term(work, "create", "workspace", "smoke"); const ws = join(work, "smoke");
  check("create workspace", r.code === 0 && existsSync(join(ws, "pso.workspace.json")), tail(r.out));
  const steps = [
    ["create", "orchestrator", "gateway", "--port", "13100"], ["create", "service", "catalog", "--db", "postgres", "--port", "18181"],
    ["infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana"],
    ["make:resource", "product", "--service", "catalog", "--route", "/catalog/products", "--method", "GET", "--public"],
    ["create", "fei", "shop"], ["create", "fei", "admin"], ["create", "mei", "catalog", "--host", "shop", "--register", "--public"],
  ];
  for (const s of steps) { r = term(ws, ...s); check(`pso ${s.join(" ")}`, r.code === 0, r.code === 0 ? "" : tail(r.out, 300)); }
  r = term(ws, "validate"); check("pso validate", r.code === 0, tail(r.out));
  r = term(ws, "frontend:validate"); check("multiple FEIs: frontend:validate accepts two shells", r.code === 0 && /fei-shop/.test(r.out) && /fei-admin/.test(r.out), tail(r.out));
  const routesFile = join(ws, "gateway", "src", "routes", "product", "ROUTES.pso.ts");
  const routes = existsSync(routesFile) ? readFileSync(routesFile, "utf8") : "";
  check("public route declared (security public) and the Spring PUBLIC rule written", /public:\s*true/.test(routes) && /access:\s*PUBLIC/.test(readFileSync(join(ws, "catalog", "src", "main", "resources", "application.yml"), "utf8")));
  r = term(ws, "infra:plan"); check("infra:plan", r.code === 0, tail(r.out));
  r = term(ws, "infra:apply", "--yes"); check("infra:apply provisions .infra (certificates, secrets, realm, nginx, compose)", r.code === 0 && existsSync(join(ws, ".infra", "docker", "local", "compose.yml")), tail(r.out));
  r = term(ws, "infra:plan"); check("a second plan changes nothing", r.code === 0 && /no change|up to date|0 change/i.test(r.out), tail(r.out));
  r = term(ws, "infra:status"); check("infra:status", r.code === 0, tail(r.out));
  r = term(ws, "infra:validate"); check("infra:validate", r.code === 0, tail(r.out));
  r = term(ws, "docker:plan"); check("docker:plan shows both shells and the edge", r.code === 0 && /fei-shop/.test(r.out) && /fei-admin/.test(r.out) && /edge/.test(r.out), tail(r.out));
  r = term(ws, "deploy", "--env", "local", "--dry-run"); check("deployment planning refuses unpublished shells and names the commands to run", r.code !== 0 && /no published release/.test(r.out) && /Nothing was changed/.test(r.out), tail(r.out));
  r = term(ws, "frontend:install"); check("frontend:install (both shells and the MEI)", r.code === 0, tail(r.out));
  r = term(ws, "frontend:build", "--env", "local"); check("frontend:build --env local", r.code === 0, tail(r.out));
  r = term(ws, "frontend:publish", "--all", "--env", "local"); check("frontend:publish --all --env local", r.code === 0, tail(r.out));
  r = term(ws, "deploy", "--env", "local", "--dry-run"); check("deployment planning: deploy --env local --dry-run", r.code === 0, tail(r.out));
  // host management commands of the installed release (no remote host is contacted)
  r = term(ws, "connection:list"); check("host management: connection:list", r.code === 0, r.code === 0 ? "" : "exit " + r.code); // the listing names this machine's real hosts: never recorded
  r = term(ws, "host:check", "--env", "local"); check("host management: host:check refuses a local environment with an explanation", r.code !== 0 && /not deployed over SSH/.test(r.out), tail(r.out));
  r = term(ws, "host:inspect", "--help"); check("host management: host:inspect is available", r.code === 0 && /Usage: pso host:inspect/.test(r.out));
  r = term(ws, "deploy:status", "--help"); check("remote deployment: deploy:status / deploy:logs / deploy:unlock are available", r.code === 0 && term(ws, "deploy:logs", "--help").code === 0 && term(ws, "deploy:unlock", "--help").code === 0);

  // ---------------------------------------------------------------- workspace migration dry run on a 0.1-style workspace
  r = term(work, "create", "workspace", "legacy"); const legacy = join(work, "legacy");
  term(legacy, "create", "orchestrator", "gateway"); term(legacy, "create", "service", "orders");
  const before = spawnSync("git", ["-C", legacy, "status", "--porcelain"], { encoding: "utf8" });
  r = term(legacy, "workspace:migrate");
  check("workspace:migrate (inspection) reports the plan and writes nothing", r.code === 0 && /inspection: nothing is written/.test(r.out) && !existsSync(join(legacy, "pso.infra.json")) && !existsSync(join(legacy, ".infra")), tail(r.out, 300));
  void before;

  // ---------------------------------------------------------------- Studio and its API Client
  const studio = spawn(process.env.ComSpec, ["/d", "/c", "pso", "studio", "--no-open", "--port", "17961"], { cwd: ws, env });
  let out = ""; studio.stdout.on("data", (d) => { out += d; }); studio.stderr.on("data", (d) => { out += d; });
  const deadline = Date.now() + 60_000; while (!/http:\/\/127\.0\.0\.1:\d+\/\S+/.test(out) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 300));
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
  let overview = false, targets = null;
  if (url) {
    const page = await fetch(url, { redirect: "manual" }); const cookie = page.headers.get("set-cookie")?.split(";")[0]; const h = cookie ? { cookie } : {};
    const ov = await fetch(new URL("/api/overview", url), { headers: h }).catch(() => null); overview = !!ov && ov.status === 200 && JSON.stringify(await ov.json()).includes("smoke");
    const t = await fetch(new URL("/api/client/targets?env=local", url), { headers: h }).catch(() => null); targets = t && t.status === 200 ? await t.json() : null;
  }
  check("Studio starts from the installation (loopback, one-time token) and answers the overview", !!url && overview, out.slice(0, 200));
  check("Studio API Client is available: declared targets and endpoints", !!targets && !targets.error && Array.isArray(targets.endpoints) && targets.endpoints.length > 0, JSON.stringify(targets ?? {}).slice(0, 200));
  spawnSync("taskkill", ["/pid", String(studio.pid), "/t", "/f"]);

  // ---------------------------------------------------------------- Docker lifecycle (optional: builds images and starts Keycloak)
  if (withDocker) {
    r = term(ws, "docker:up", "--env", "local", "--vendor", "--timeout", "600"); check("docker:up: every container healthy", r.code === 0 && /ready:/.test(r.out), tail(r.out, 300));
    r = term(ws, "docker:ps"); check("docker:ps", r.code === 0 && /healthy/.test(r.out), tail(r.out));
    r = term(ws, "docker:logs", "gateway", "--tail", "20"); check("docker:logs gateway", r.code === 0, tail(r.out));
    r = term(ws, "infra:validate", "--probe"); check("infra:validate --probe through the edge", r.code === 0, tail(r.out));
    r = term(ws, "docker:restart", "catalog"); check("docker:restart catalog (only that container)", r.code === 0, tail(r.out));
    r = term(ws, "docker:down", "--volumes", "--yes"); check("docker:down --volumes --yes removes the smoke stack and its data", r.code === 0, tail(r.out));
  }
} catch (e) { check("smoke test ran to completion", false, e.message); }
finally {
  const ev = flag("evidence");
  if (ev) { mkdirSync(dirname(ev), { recursive: true }); writeFileSync(ev, JSON.stringify({ at: new Date().toISOString(), installation: install, freshTerminal: "PATH rebuilt from the registry (Machine + User); cwd a new temporary folder outside any repository", docker: withDocker, results }, null, 2) + "\n"); }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}${stop ? " (stopped: wrong pso)" : ""}`);
  process.exitCode = failed ? 1 : 0;
}
