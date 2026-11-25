import { defineRoutes } from "@pso/http";
import { OverviewController } from "./overview.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/overview/orders/:id",
      controller: OverviewController,
      action: "show",
      security: { guard: "jwt", scopes: ["orders:read"] },
      metadata: { services: ["orders","customers","catalog"] }
    }
  ]
});
