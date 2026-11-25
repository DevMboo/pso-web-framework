import { defineRoutes } from "@pso/http";
import { ProductsController } from "./products.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/products",
      controller: ProductsController,
      action: "findAll",
      security: { guard: "jwt", scopes: ["catalog:read"] },
      metadata: { service: "catalog" },
      responses: { 200: "ProductResponse[]", 401: "problem", 403: "problem" }
    },
    {
      method: "POST",
      path: "/products",
      controller: ProductsController,
      action: "create",
      security: { guard: "jwt", scopes: ["catalog:write"] },
      metadata: { service: "catalog" },
      responses: { 201: "ProductResponse", 400: "problem", 401: "problem", 403: "problem", 409: "problem" }
    },
    {
      method: "GET",
      path: "/products/:id",
      controller: ProductsController,
      action: "findById",
      security: { guard: "jwt", scopes: ["catalog:read"] },
      metadata: { service: "catalog" },
      responses: { 200: "ProductResponse", 401: "problem", 403: "problem", 404: "problem" }
    },
    {
      method: "PUT",
      path: "/products/:id",
      controller: ProductsController,
      action: "update",
      security: { guard: "jwt", scopes: ["catalog:write"] },
      metadata: { service: "catalog" }
    },
    {
      method: "PATCH",
      path: "/products/:id/stock",
      controller: ProductsController,
      action: "setStock",
      security: { guard: "jwt", scopes: ["catalog:write"] },
      metadata: { service: "catalog" },
      responses: { 200: "ProductResponse", 400: "problem", 401: "problem", 403: "problem", 404: "problem", 409: "problem" }
    }
  ]
});
