import { defineRoutes } from "@pso/http";
import { OrdersController } from "./orders.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "POST",
      path: "/orders",
      controller: OrdersController,
      action: "create",
      security: { guard: "jwt", scopes: ["orders:write"] },
      metadata: { service: "orders" }
    },
    {
      method: "GET",
      path: "/orders/:id",
      controller: OrdersController,
      action: "findOne",
      security: { guard: "jwt", scopes: ["orders:read"] },
      metadata: { service: "orders" }
    }
  ]
});
