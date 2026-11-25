import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { TEMPLATES_DIR } from "./templates.ts";

/**
 * Dependency specs written into generated orchestrators. While @pso/* is not published, a checkout of the
 * framework next to this CLI is referenced with an absolute file: spec; otherwise the registry range is used.
 */
export function frameworkSpecs(): { coreSpec: string; httpSpec: string; securitySpec: string; dispatchSpec: string; channelsSpec: string; channelsClientSpec: string; reactChannelsSpec: string } {
  const pk = (n: string) => resolve(TEMPLATES_DIR, "..", "..", n);
  const local = (n: string) => (existsSync(join(pk(n), "package.json")) && existsSync(join(pk(n), "dist")) ? `file:${pk(n).split("\\").join("/")}` : "^0.2.0");
  return { coreSpec: local("core"), httpSpec: local("http"), securitySpec: local("security"), dispatchSpec: local("dispatch"), channelsSpec: local("channels"), channelsClientSpec: local("channels-client"), reactChannelsSpec: local("react-channels") };
}

/** The PSO Java ecosystem (Maven multi-module project) next to the CLI checkout, or undefined when the CLI is installed on its own. */
export function psoJavaDir(): string | undefined {
  const dir = resolve(TEMPLATES_DIR, "..", "..", "..", "pso-java");
  return existsSync(join(dir, "pom.xml")) ? dir : undefined;
}

/** The newest version of com.pso:pso-bom in a Maven repository directory (releases before SNAPSHOTs), or undefined. */
export function newestBomVersion(repository: string): string | undefined {
  const dir = join(repository, "com", "pso", "pso-bom");
  if (!existsSync(dir)) return undefined;
  const versions = readdirSync(dir).filter((v) => existsSync(join(dir, v, `pso-bom-${v}.pom`)));
  const key = (v: string): number[] => v.replace(/-SNAPSHOT$/, "").split(".").map((n) => Number(n) || 0);
  const cmp = (a: string, b: string): number => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return Number(/-SNAPSHOT$/.test(b)) - Number(/-SNAPSHOT$/.test(a)); };
  return versions.sort(cmp).pop();
}

/** A Maven file repository shipped next to an installed CLI (a release package that carries the Java artifacts), or undefined. */
export function bundledMavenRepository(): string | undefined {
  for (const dir of [resolve(TEMPLATES_DIR, "..", "..", "..", "maven-repository"), resolve(TEMPLATES_DIR, "..", "..", "..", "..", "maven-repository")]) if (newestBomVersion(dir)) return dir;
  return undefined;
}

/**
 * The PSO Java release this CLI is built for. A CLI installed without the framework sources generates services for exactly this
 * version: the generated templates and the Java libraries change together, so an older or newer release found on the machine is
 * never used instead (it may lack what the templates need). `pso java:install` installs it from the release's Maven repository.
 */
export const PSO_JAVA_VERSION = "0.2.0-rc.6";

/**
 * The version of the PSO Java artifacts that generated services depend on: the checkout's (parent pom) when the CLI runs from a
 * framework checkout, where the sources are built together (`pso java:install`); otherwise the release this CLI is bound to.
 */
export function psoJavaVersion(): string {
  const dir = psoJavaDir();
  if (dir) {
    const m = /<artifactId>pso-parent<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(readFileSync(join(dir, "pom.xml"), "utf8"));
    if (m) return m[1]!;
  }
  return PSO_JAVA_VERSION;
}

/** Whether the PSO Java artifacts of `version` are in the local Maven repository (what `pso java:install` produces). */
export function psoJavaInstalled(version: string, home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? ""): boolean {
  return existsSync(join(home, ".m2", "repository", "com", "pso", "pso-bom", version, `pso-bom-${version}.pom`));
}
