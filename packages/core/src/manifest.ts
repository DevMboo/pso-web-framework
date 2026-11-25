import { createHash } from "node:crypto";
import { SCHEMA_VERSION, type Runtime } from "./conventions.ts";
import type { Discovery } from "./discovery.ts";

export interface Manifest {
  schemaVersion: number;
  runtime: Runtime;
  resources: Array<{ key: string; kind: string; id: string; file: string }>;
  /** sha256 over the canonical resource list: identical inputs always yield an identical digest */
  digest: string;
}

/** Deterministic: no timestamps, no absolute paths, stable ordering. */
export function buildManifest(d: Discovery): Manifest {
  const resources = d.resources.map(({ key, kind, id, file }) => ({ key, kind, id, file }));
  const digest = createHash("sha256").update(JSON.stringify([SCHEMA_VERSION, d.runtime, resources])).digest("hex");
  return { schemaVersion: SCHEMA_VERSION, runtime: d.runtime, resources, digest };
}

export const serializeManifest = (m: Manifest): string => JSON.stringify(m, null, 2) + "\n";
