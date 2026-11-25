import { defineRoutes } from "@pso/http";
import { UserController } from "./user.controller";

// The authoritative endpoint registry of this module: only routes listed here can be activated.
export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/accounts/users",
      controller: UserController,
      action: "findAll",
      security: { guard: "jwt", scopes: ["users:admin"] },
      metadata: { service: "accounts" }
    }
  ]
});
