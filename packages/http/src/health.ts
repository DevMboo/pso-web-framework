import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModuleDefinition } from "@pso/core";
import { Controller, RestController, Get, Public, Req, Res } from "./decorators.ts";
import { modelFromDefinitions, type LoadedModule } from "./model.ts";
import { defineRoutes } from "./routes.ts";
import type { ReadinessReport } from "./readiness.ts";
import { contexts } from "./context.ts";
import { send } from "./responses.ts";
import { Upstream } from "./upstream.ts";

// ---------- framework-owned health module (declared and validated like any other) ----------
/**
 * Liveness answers "is the process able to run" and never looks at dependencies. Readiness answers "may this instance receive traffic":
 * 200 {"status":"UP","upstreams":n} once start-up finished and every REQUIRED dependency is available, 503 {"status":"DOWN",...} while
 * starting, while shutting down or while a required dependency is down. `checks` appears only when the instance has dependencies to
 * report (dispatch broker, shared channels bus, shared rate-limit store); upstream services are counted, not probed (see readiness.ts).
 */
export function healthModule(report: () => ReadinessReport): LoadedModule {
  // one controller class per application: two orchestrators in one process never share readiness
  class HealthController {
    live(): { status: string } { return { status: "UP" }; }
    ready(req: IncomingMessage, res: ServerResponse): unknown {
      const r = report();
      const body = { status: r.status, upstreams: Upstream.services.size, ...(Object.keys(r.checks).length ? { checks: r.checks } : {}) };
      if (r.status === "UP") return body;
      res.setHeader("retry-after", "5");
      send(res, 503, { ...body, state: r.state }, contexts.get(req)?.correlationId ?? randomUUID());
      return undefined;
    }
  }
  Controller()(HealthController);
  RestController("/health")(HealthController);
  Get("/live")(HealthController.prototype, "live");
  Get("/ready")(HealthController.prototype, "ready");
  Req()(HealthController.prototype, "ready", 0);
  Res()(HealthController.prototype, "ready", 1);
  Public()(HealthController.prototype, "live");
  Public()(HealthController.prototype, "ready");
  const routes = defineRoutes({ routes: [
    { method: "GET", path: "/health/live", controller: HealthController, action: "live", security: { public: true } },
    { method: "GET", path: "/health/ready", controller: HealthController, action: "ready", security: { public: true } },
  ] });
  const def = { name: "health", controllers: [HealthController], providers: [], routes, imports: [], exports: [] } as unknown as ModuleDefinition;
  return { model: modelFromDefinitions("health", def, routes, {}), def, routes, ignoredControllerFiles: [] };
}
