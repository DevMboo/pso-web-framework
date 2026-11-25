import { join } from "node:path";
import { INFRA_DIR } from "./contract.ts";
import { atomicWrite, readText } from "./fsutil.ts";

/**
 * `.infra/state.json`: what PSO provisioned, per environment and resource. It records ownership and the hash of every file PSO wrote, so a
 * later run can tell the three cases apart that matter: a file PSO wrote and nobody touched (safe to update when the declaration changes),
 * a file somebody edited by hand (drift: reported, never silently overwritten) and a file PSO never wrote (not PSO's to change).
 * It never contains key material or secret values: only paths, hashes of public or generated configuration, fingerprints and dates.
 */
export interface ResourceRecord {
  kind: string;
  owner: "pso" | "external";
  /** workspace-relative path -> sha256 of the content PSO wrote (for sensitive files: the hash is of the file and reveals nothing usable) */
  files: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** certificate fingerprint, expiry, etc. */
  facts?: Record<string, string | number | boolean>;
  /** where an adopted resource came from (migration) */
  origin?: string;
}
export interface EnvironmentState { resources: Record<string, ResourceRecord>; lastApply?: { at: string; by: string; changed: number; pso: string } }
export interface InfraState { schema: 1; environments: Record<string, EnvironmentState> }

const file = (root: string) => join(root, INFRA_DIR, "state.json");

export function readState(root: string): InfraState {
  const t = readText(file(root));
  if (!t) return { schema: 1, environments: {} };
  try { const s = JSON.parse(t) as InfraState; return s.schema === 1 && s.environments ? s : { schema: 1, environments: {} }; }
  catch { return { schema: 1, environments: {} }; }
}
export function writeState(root: string, s: InfraState): void { atomicWrite(file(root), JSON.stringify(s, null, 2) + "\n"); }
export function envState(s: InfraState, env: string): EnvironmentState { return (s.environments[env] ??= { resources: {} }); }
