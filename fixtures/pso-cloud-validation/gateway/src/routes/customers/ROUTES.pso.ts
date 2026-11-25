import { defineRoutes } from "@pso/http";
import { CustomersController } from "./customers.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "POST",
      path: "/customers",
      controller: CustomersController,
      action: "create",
      security: { guard: "jwt", scopes: ["customers:write"] },
      metadata: { service: "customers" }
    },
    {
      method: "GET",
      path: "/customers/:id",
      controller: CustomersController,
      action: "findOne",
      security: { guard: "jwt", scopes: ["customers:read"] },
      metadata: { service: "customers" }
    }
  ]
});
