import { defineRoutes } from "@pso/http";
import { OrdersController } from "./orders.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/orders",
      controller: OrdersController,
      action: "findAll",
      security: { guard: "jwt", scopes: ["orders:read"] },
      metadata: { service: "orders" },
      responses: { 200: "OrderResponse[]", 401: "problem", 403: "problem" }
    },
    {
      method: "POST",
      path: "/orders",
      controller: OrdersController,
      action: "place",
      security: { guard: "jwt", scopes: ["orders:write"] },
      metadata: { service: "orders" },
      responses: { 201: "OrderResponse", 400: "problem", 401: "problem", 403: "problem", 404: "problem", 409: "problem" }
    },
    {
      method: "GET",
      path: "/orders/:id",
      controller: OrdersController,
      action: "findById",
      security: { guard: "jwt", scopes: ["orders:read"] },
      metadata: { service: "orders" },
      responses: { 200: "OrderResponse", 401: "problem", 403: "problem", 404: "problem" }
    }
  ]
});
