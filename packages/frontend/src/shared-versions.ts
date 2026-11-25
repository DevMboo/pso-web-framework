import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The dependencies a FEI and its MEIs share as singletons. Kept apart from the TypeScript-based tooling so the runtime agent can use it. */
export const SHARED_SINGLETONS = ["react", "react-dom", "react-router-dom", "react-router", "@pso/frontend", "@pso/frontend-react", "@pso/frontend-client"] as const;

/** The exact versions installed in a project, recorded in its release manifest and compared before a release is activated. */
export function installedVersions(dir: string, names: readonly string[] = SHARED_SINGLETONS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const f = join(dir, "node_modules", ...n.split("/"), "package.json");
    if (existsSync(f)) out[n] = (JSON.parse(readFileSync(f, "utf8")) as { version: string }).version;
  }
  return out;
}
