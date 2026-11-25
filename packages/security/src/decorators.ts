import "reflect-metadata";

// Metadata keys shared with @pso/http (kept as literals so the packages do not depend on each other).
const SCOPES = "pso:scopes", ROLES = "pso:roles", PARAMS = "pso:params";

type Target = object;
const meta = (key: string, values: string[]) => (target: Target, prop?: string | symbol): void => {
  for (const v of values) if (!/^[A-Za-z0-9:._\-/]+$/.test(v)) throw new Error(`invalid ${key === SCOPES ? "scope" : "role"} name "${v}"`);
  if (prop === undefined) Reflect.defineMetadata(key, [...(Reflect.getOwnMetadata(key, target) as string[] | undefined ?? []), ...values], target);
  else Reflect.defineMetadata(key, [...(Reflect.getOwnMetadata(key, target, prop) as string[] | undefined ?? []), ...values], target, prop);
};

/**
 * Class or method decorator: the caller must have EVERY listed scope. Requirements from module, controller, action and route
 * declaration add up. The route still has to be declared in ROUTES.pso.ts: this decorator exposes nothing by itself.
 */
export const RequireScopes = (...scopes: string[]) => meta(SCOPES, scopes);

/**
 * Class or method decorator: the caller must have AT LEAST ONE of the listed roles. When several levels declare roles, each
 * level's requirement must be satisfied (AND of ORs), so a lower level can only restrict further.
 */
export const RequireRoles = (...roles: string[]) => meta(ROLES, roles);

/** Parameter decorator: injects the verified `Principal` of the current request (undefined on public routes). */
export const CurrentPrincipal = () => (target: Target, key: string | symbol | undefined, index: number): void => {
  if (key === undefined) return;
  const list = (Reflect.getOwnMetadata(PARAMS, target, key) as Array<{ index: number; kind: string }> | undefined) ?? [];
  Reflect.defineMetadata(PARAMS, [...list, { index, kind: "principal" }], target, key);
};
