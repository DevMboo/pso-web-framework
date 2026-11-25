import { defineModule } from "@pso/core";
import playgroundRoutes from "./ROUTES.pso";
import { PlaygroundController } from "./playground.controller";

export default defineModule({
  name: "playground",
  controllers: [PlaygroundController],
  providers: [],
  routes: playgroundRoutes,
  imports: [],
  exports: []
});
