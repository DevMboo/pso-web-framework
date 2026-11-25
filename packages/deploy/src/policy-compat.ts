import { createHash } from "node:crypto";
import type { Policy } from "./agent/state.ts";

/**
 * Compatibility between the agent that is installed and the policy the server was provisioned with.
 *
 * A server policy is the administrator's decision, and it fails closed: a capability the agent gained after the policy was written is NOT
 * permitted until someone with authority says so. An agent upgrade therefore never changes the policy. This module names the capabilities,
 * says which ones the current policy permits, and describes each pending change as an exact difference ("migration") that an administrator
 * can preview, apply (audited) and revert. It is a view over the one policy the server already has, not a second policy system.
 */
export const SUPPORTED_POLICY_VERSIONS = [1] as const;

export interface Capability { id: string; introducedIn: string; summary: string; permitted: (p: Policy) => boolean }
export const CAPABILITIES: Capability[] = [
  { id: "strategy.blue-green", introducedIn: "0.1.0", summary: "deploy services with blue-green switching behind nginx", permitted: (p) => p.allowedStrategies.includes("blue-green") },
  { id: "strategy.rolling", introducedIn: "0.1.0", summary: "deploy services with rolling replacement", permitted: (p) => p.allowedStrategies.includes("rolling") },
  { id: "strategy.recreate", introducedIn: "0.1.0", summary: "deploy services by stopping the old release first (with acknowledged downtime)", permitted: (p) => p.allowedStrategies.includes("recreate") },
  { id: "strategy.static", introducedIn: "0.2.0", summary: "deploy static frontends (shell and microfrontends): files in a site root served by managed nginx, no process", permitted: (p) => p.allowedStrategies.includes("static") },
];

export interface Migration {
  id: string;
  introducedIn: string;
  summary: string;
  /** what the change PERMITS, in words: shown before it is applied */
  grants: string[];
  /** the keys it would change, or undefined when the policy already satisfies it */
  changes(p: Policy): Partial<Record<keyof Policy, unknown>> | undefined;
}
export const MIGRATIONS: Migration[] = [
  {
    id: "allow-static-frontends", introducedIn: "0.2.0", summary: "Permit the \"static\" deployment strategy",
    grants: ["deployments of kind static frontend may be planned and run: their files are written under the agent's site root and, for a shell, one managed nginx file is written and reloaded (always after nginx -t)", "no other permission changes: approvals, signatures, retention, nginx privilege and the other strategies stay as they are"],
    changes: (p) => (p.allowedStrategies.includes("static") ? undefined : { allowedStrategies: [...p.allowedStrategies, "static"] }),
  },
];

export interface MigrationPreview { id: string; introducedIn: string; summary: string; grants: string[]; pending: boolean; changes: Record<string, { from: unknown; to: unknown }>; /** identifies exactly this difference: applying requires it, so a policy that changed in between is refused */ digest: string }

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const digestOf = (id: string, changes: Record<string, { from: unknown; to: unknown }>): string => createHash("sha256").update(stable({ id, changes })).digest("hex").slice(0, 16);

export function previewMigration(m: Migration, p: Policy): MigrationPreview {
  const to = m.changes(p) ?? {};
  const changes = Object.fromEntries(Object.entries(to).map(([k, v]) => [k, { from: (p as unknown as Record<string, unknown>)[k], to: v }]));
  return { id: m.id, introducedIn: m.introducedIn, summary: m.summary, grants: m.grants, pending: Object.keys(changes).length > 0, changes, digest: digestOf(m.id, changes) };
}

export interface Compatibility {
  agentVersion: string;
  policyVersion: number;
  policyVersionSupported: boolean;
  capabilities: Array<{ id: string; introducedIn: string; summary: string; status: "permitted" | "not-permitted" }>;
  migrations: MigrationPreview[];
  /** strategies the agent implements that the policy does not permit */
  unsupportedStrategies: string[];
  notes: string[];
}
export function compatibility(p: Policy, agentVersion: string): Compatibility {
  const capabilities = CAPABILITIES.map((c) => ({ id: c.id, introducedIn: c.introducedIn, summary: c.summary, status: (c.permitted(p) ? "permitted" : "not-permitted") as "permitted" | "not-permitted" }));
  const supported = (SUPPORTED_POLICY_VERSIONS as readonly number[]).includes(p.version);
  const migrations = MIGRATIONS.map((m) => previewMigration(m, p));
  const unsupportedStrategies = capabilities.filter((c) => c.id.startsWith("strategy.") && c.status === "not-permitted").map((c) => c.id.slice("strategy.".length));
  const notes = [
    supported ? "The policy version is understood by this agent." : `This agent does not understand policy version ${p.version} (supported: ${SUPPORTED_POLICY_VERSIONS.join(", ")}): it refuses to act on it.`,
    "An agent upgrade never changes the policy. A capability the policy does not permit stays refused (fail closed) until a migration is applied by an administrator.",
  ];
  return { agentVersion, policyVersion: p.version, policyVersionSupported: supported, capabilities, migrations, unsupportedStrategies, notes };
}

export interface PolicyHistoryEntry {
  id: string;
  at: string;
  by: string;
  kind: "set" | "migration" | "revert";
  migration?: string;
  /** only the keys that changed */
  changes: Record<string, { from: unknown; to: unknown }>;
  /** the whole policy before the change, kept for reference and audit */
  before: Policy;
  revertedBy?: string;
}
