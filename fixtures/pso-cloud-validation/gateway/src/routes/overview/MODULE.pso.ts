import { defineModule } from "@pso/core";
import overviewRoutes from "./ROUTES.pso";
import { OverviewController } from "./overview.controller";

export default defineModule({
  name: "overview",
  controllers: [OverviewController],
  providers: [],
  routes: overviewRoutes,
  imports: [],
  exports: []
});
