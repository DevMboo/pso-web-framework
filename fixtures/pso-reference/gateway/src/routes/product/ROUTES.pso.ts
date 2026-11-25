import { defineRoutes } from "@pso/http";
import { ProductController } from "./product.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/catalog/products",
      controller: ProductController,
      action: "findAll",
      security: { public: true },
      metadata: { service: "catalog" }
    }
  ]
});
