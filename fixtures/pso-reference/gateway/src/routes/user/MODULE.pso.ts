import { defineModule } from "@pso/core";
import userRoutes from "./ROUTES.pso";
import { UserController } from "./user.controller";

export default defineModule({
  name: "user",
  controllers: [UserController],
  providers: [],
  routes: userRoutes,
  imports: [],
  exports: []
});
