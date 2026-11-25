import { defineRoutes } from "@pso/http";
import { ProductsController } from "./products.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/products",
      controller: ProductsController,
      action: "list",
      security: { guard: "jwt", scopes: ["products:read"] },
      metadata: { service: "catalog" }
    },
    {
      method: "GET",
      path: "/products/:id",
      controller: ProductsController,
      action: "findOne",
      security: { guard: "jwt", scopes: ["products:read"] },
      metadata: { service: "catalog" }
    },
    {
      method: "POST",
      path: "/products",
      controller: ProductsController,
      action: "create",
      security: { guard: "jwt", scopes: ["products:write"] },
      metadata: { service: "catalog" }
    },
    {
      method: "PUT",
      path: "/products/:id",
      controller: ProductsController,
      action: "replace",
      security: { guard: "jwt", scopes: ["products:write"] },
      metadata: { service: "catalog" }
    },
    {
      method: "DELETE",
      path: "/products/:id",
      controller: ProductsController,
      action: "remove",
      security: { guard: "jwt", scopes: ["products:write"] },
      metadata: { service: "catalog" }
    },
    {
      method: "GET",
      path: "/products/search",
      controller: ProductsController,
      action: "search",
      security: { guard: "jwt", scopes: ["products:read"] },
      metadata: { service: "catalog" }
    },
    {
      method: "PATCH",
      path: "/products/:id",
      controller: ProductsController,
      action: "patch",
      security: { guard: "jwt", scopes: ["products:write"] },
      metadata: { service: "catalog" }
    }
  ]
});
