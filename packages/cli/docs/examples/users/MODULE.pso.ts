import { defineModule } from "@pso/core";
import { UsersController } from "./controllers/users.controller";
import { UsersService } from "./services/users.service";
import usersRoutes from "./routes/ROUTES.pso";

export default defineModule({
  name: "users",
  controllers: [UsersController],
  providers: [UsersService],
  routes: usersRoutes,
  imports: [],
  exports: [UsersService]
});
