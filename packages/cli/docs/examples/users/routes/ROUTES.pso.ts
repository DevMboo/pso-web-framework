import { defineRoutes } from "@pso/http";
import { UsersController } from "../controllers/users.controller";

export default defineRoutes({
  routes: [
    { method: "GET", path: "/users", controller: UsersController, action: "findAll", security: { public: true } },
    { method: "GET", path: "/users/:id", controller: UsersController, action: "findById", security: { guard: "users-key" } },
    { method: "POST", path: "/users", controller: UsersController, action: "create", security: { guard: "users-key" } }
  ]
});
