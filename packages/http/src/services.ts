/**
 * Names an application can have the compiler check. Both interfaces are empty by default, so every string is accepted; an
 * application that declares its names gets them checked wherever a service or a guard is named (route metadata and security,
 * `Upstream.forward`, `UpstreamClient`):
 *
 *   declare module "@pso/http" { interface PsoServices { customers: true; orders: true } interface PsoGuards { jwt: true } }
 *
 * `pso types` writes that declaration from pso.workspace.json and the project's guards. The run-time checks (a registered service
 * that the route declares, an existing guard) are unchanged and do not depend on it.
 */
import type { PsoGuards, PsoServices } from "./index.ts";

/** A registered service name: the keys of `PsoServices` once the application declares them, any string until then. */
export type ServiceName = keyof PsoServices extends never ? string : Extract<keyof PsoServices, string>;
/** A guard name: the keys of `PsoGuards` once the application declares them, any string until then. */
export type GuardName = keyof PsoGuards extends never ? string : Extract<keyof PsoGuards, string>;
