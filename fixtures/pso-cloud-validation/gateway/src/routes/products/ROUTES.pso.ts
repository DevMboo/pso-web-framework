import { defineRoutes } from "@pso/http";
import { ProductsController } from "./products.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "POST",
      path: "/products",
      controller: ProductsController,
      action: "create",
      security: { guard: "jwt", scopes: ["catalog:write"] },
      metadata: { service: "catalog" }
    },
    {
      method: "GET",
      path: "/products/:id",
      controller: ProductsController,
      action: "findOne",
      security: { guard: "jwt", scopes: ["catalog:read"] },
      metadata: { service: "catalog" }
    }
  ]
});
