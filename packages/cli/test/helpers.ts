import { mkdtempSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { run } from "../src/main.ts";
import { TEMPLATES_DIR } from "../src/templates.ts";
import { frameworkSpecs } from "../src/specs.ts";

export async function pso(cwd: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await run(argv, cwd, (s) => { out += s + "\n"; }, (s) => { err += s + "\n"; });
  return { code, out, err };
}
export const tmp = (p = "pso-") => mkdtempSync(join(tmpdir(), p));
export const read = (...p: string[]) => readFileSync(join(...p), "utf8");

let nm: string | undefined;
/** Installs the orchestrator's real dependencies (including the framework packages and TypeScript) once per test run. */
export function orchestratorNodeModules(): string {
  if (nm) return nm;
  const dir = tmp("pso-nm-");
  const { coreSpec, httpSpec, securitySpec } = frameworkSpecs();
  writeFileSync(join(dir, "package.json"), readFileSync(join(TEMPLATES_DIR, "orchestrator", "package.json"), "utf8").replace("{{name}}", "fixture").replace("{{coreSpec}}", coreSpec).replace("{{httpSpec}}", httpSpec).replace("{{securitySpec}}", securitySpec));
  // dispatch is optional in generated projects (`pso dispatch:install` adds these); the fixture carries them so those projects can run
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  Object.assign(pj.dependencies, { "@pso/dispatch": frameworkSpecs().dispatchSpec, "@pso/channels": frameworkSpecs().channelsSpec, ioredis: "^5.4.1", amqplib: "^0.10.4", kafkajs: "^2.2.4" });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pj, null, 2));
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 });
  if (r.status !== 0) throw new Error(`npm install failed: ${r.stderr}`);
  nm = join(dir, "node_modules");
  return nm;
}
export const linkModules = (project: string) => symlinkSync(orchestratorNodeModules(), join(project, "node_modules"), "junction");

/** Compiles an orchestrator project with the real TypeScript compiler (decorators + metadata). Throws with tsc's output on error. */
export function compileProject(project: string): void {
  const r = spawnSync(process.execPath, [join(orchestratorNodeModules(), "typescript", "bin", "tsc"), "-p", project], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
}

/** link node_modules + compile: makes a freshly generated orchestrator runnable. */
export function prepare(project: string): void { linkModules(project); compileProject(project); }

export async function listen(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as { port: number }).port };
}

export async function startNode(cwd: string, env: Record<string, string>, readyRe = /orchestrator listening/): Promise<{ child: ChildProcess; logs: () => string }> {
  const child = spawn(process.execPath, ["dist/main.js"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout!.on("data", (d: Buffer) => { logs += d; });
  child.stderr!.on("data", (d: Buffer) => { logs += d; });
  for (let i = 0; i < 150 && !readyRe.test(logs) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  if (!readyRe.test(logs)) { child.kill("SIGKILL"); throw new Error(`did not start:\n${logs}`); }
  return { child, logs: () => logs };
}

export const randomPort = () => 39000 + Math.floor(Math.random() * 900);

/** A port that is free right now (the OS picks it). Tests use it for the "upstream that is not running" so they never depend on well-known ports being free. */
export async function unusedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}
