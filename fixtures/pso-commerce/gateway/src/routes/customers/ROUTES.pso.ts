import { defineRoutes } from "@pso/http";
import { CustomersController } from "./customers.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/customers",
      controller: CustomersController,
      action: "findAll",
      security: { guard: "jwt", scopes: ["customers:read"] },
      metadata: { service: "customers" },
      responses: { 200: "CustomerResponse[]", 401: "problem", 403: "problem" }
    },
    {
      method: "POST",
      path: "/customers",
      controller: CustomersController,
      action: "create",
      security: { guard: "jwt", scopes: ["customers:write"] },
      metadata: { service: "customers" },
      responses: { 201: "CustomerResponse", 400: "problem", 401: "problem", 403: "problem", 409: "problem" }
    },
    {
      method: "GET",
      path: "/customers/:id",
      controller: CustomersController,
      action: "findById",
      security: { guard: "jwt", scopes: ["customers:read"] },
      metadata: { service: "customers" },
      responses: { 200: "CustomerResponse", 401: "problem", 403: "problem", 404: "problem" }
    },
    {
      method: "PUT",
      path: "/customers/:id",
      controller: CustomersController,
      action: "update",
      security: { guard: "jwt", scopes: ["customers:write"] },
      metadata: { service: "customers" }
    },
    {
      method: "PATCH",
      path: "/customers/:id/status",
      controller: CustomersController,
      action: "setStatus",
      security: { guard: "jwt", scopes: ["customers:write"] },
      metadata: { service: "customers" },
      responses: { 200: "CustomerResponse", 400: "problem", 401: "problem", 403: "problem", 404: "problem" }
    },
    {
      method: "GET",
      path: "/customers/:id/summary",
      controller: CustomersController,
      action: "summary",
      security: { guard: "jwt", scopes: ["customers:read","orders:read"] },
      metadata: { services: ["customers","orders","catalog"] }
    }
  ]
});
