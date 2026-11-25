import type { Principal } from "./principal.ts";

/**
 * Authorization is separate from authentication: authentication establishes WHO the caller is (a Principal); authorization
 * decides whether that Principal may do THIS. Requirements only ever add up across module, controller, action and route.
 *   scopes      every listed scope is required
 *   roleSets    AND of ORs: each set needs at least one of its roles
 *   permissions every listed permission is required
 */
export interface Requirement { scopes?: readonly string[]; roleSets?: readonly (readonly string[])[]; permissions?: readonly string[] }

export type Decision = { allowed: true } | { allowed: false; missing: { scopes: string[]; roleSets: string[][]; permissions: string[] } };

export const isEmptyRequirement = (r: Requirement): boolean => !(r.scopes?.length || r.roleSets?.some((s) => s.length) || r.permissions?.length);

export function evaluate(principal: Principal, req: Requirement): Decision {
  const scopes = (req.scopes ?? []).filter((s) => !principal.hasScope(s));
  const roleSets = (req.roleSets ?? []).filter((set) => set.length > 0 && !set.some((r) => principal.hasRole(r))).map((s) => [...s]);
  const permissions = (req.permissions ?? []).filter((p) => !principal.hasPermission(p));
  return scopes.length || roleSets.length || permissions.length ? { allowed: false, missing: { scopes, roleSets, permissions } } : { allowed: true };
}

/** An extra policy a guard can add on top of authentication. It can restrict further but can never remove authentication. */
export type Policy = (principal: Principal) => boolean | { allowed: boolean; reason?: string };

/** All policies must allow. */
export function composePolicies(...policies: Policy[]): Policy {
  return (p) => { for (const pol of policies) { const r = pol(p); if (r === false || (typeof r === "object" && !r.allowed)) return typeof r === "object" ? r : { allowed: false }; } return true; };
}
export const describeMissing = (m: { scopes: string[]; roleSets: string[][]; permissions: string[] }): string =>
  [...m.scopes.map((s) => `scope:${s}`), ...m.roleSets.map((r) => `role:${r.join("|")}`), ...m.permissions.map((p) => `permission:${p}`)].join(",");
