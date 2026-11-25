import type { HttpMethod } from "@pso/core";
import type { GuardName, ServiceName } from "./services.ts";

export interface RouteEntry {
  method: HttpMethod;
  /** the full public path, e.g. "/users/:id". Must equal @RestController prefix + action path. */
  path: string;
  controller: abstract new (...args: never[]) => unknown;
  action: string;
  /** security policy: exactly one of `public: true` or one or more guards is required (deny by default) */
  security?: { public?: boolean; guard?: GuardName; scopes?: readonly string[]; roles?: readonly string[] };
  guards?: readonly GuardName[];
  middleware?: readonly string[];
  /** interceptors (.app/interceptors/<name>.interceptor.ts) that run around the action, in this order: they can time, audit or transform its result */
  interceptors?: readonly string[];
  filters?: readonly string[];
  /**
   * Free-form route metadata. `service` names the upstream the action forwards to (`Upstream.forward`); `services` names the
   * upstreams the action calls to compose its response (`UpstreamClient`). Both are checked against the workspace by `pso validate`
   * and enforced by the runtime: an action cannot reach a service its route did not declare.
   */
  metadata?: { service?: ServiceName; services?: readonly ServiceName[] } & Record<string, unknown>;
  /** API version: the route is served under /v<version> */
  version?: string;
  /**
   * OPTIONAL, additive response contract of this route, published to typed frontends by `pso frontend:contracts`. Metadata only: the
   * orchestrator does not rewrite or validate what the service answers, and a route without it keeps working (its response is simply
   * untyped for the frontend). Keys are HTTP status codes; values name a `@Dto()` class of this orchestrator:
   *   200: "CustomerResponse"           a body       201: "CustomerResponse"
   *   200: "CustomerResponse[]"         a collection 200: "CustomerResponse | null"   a nullable body
   *   204: "void"                       no body      404: "problem"                  an RFC 9457 Problem Details body
   * Pagination is a DTO you declare (for example `CustomerPage { items: CustomerResponse[]; total: number }`): PSO does not invent an envelope.
   * It must be a string literal in ROUTES.pso.ts: the generator reads it statically, never from a running service.
   */
  responses?: Readonly<Record<number, string>>;
}
export interface RoutesDefinition { readonly routes: readonly RouteEntry[] }
export const ROUTES_BRAND = Symbol.for("pso.routes");

/** The authoritative endpoint registry of a module. Only routes listed here can ever be activated. */
export function defineRoutes(def: RoutesDefinition): RoutesDefinition {
  if (!def || !Array.isArray(def.routes)) throw new Error("defineRoutes() expects { routes: [...] }");
  for (const r of def.routes) {
    if (typeof r?.action !== "string" || typeof r.controller !== "function") throw new Error("defineRoutes(): every route needs a controller class and an action name");
  }
  return Object.freeze({ ...def, [ROUTES_BRAND]: true });
}
