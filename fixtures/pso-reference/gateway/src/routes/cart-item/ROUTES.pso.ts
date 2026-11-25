import { defineRoutes } from "@pso/http";
import { CartItemController } from "./cart-item.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "POST",
      path: "/catalog/cart-items",
      controller: CartItemController,
      action: "create",
      security: { guard: "jwt", scopes: ["cart:write"] },
      metadata: { service: "catalog" }
    }
  ]
});
