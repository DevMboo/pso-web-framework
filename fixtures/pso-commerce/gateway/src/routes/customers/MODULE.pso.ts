import { defineModule } from "@pso/core";
import customersRoutes from "./ROUTES.pso";
import { CustomersController } from "./customers.controller";
import { SummaryService } from "./summary.service";
import { ClockProvider } from "../../providers/clock.provider";
import { StartupHook } from "../../hooks/startup.hook";

export default defineModule({
  name: "customers",
  controllers: [CustomersController],
  providers: [SummaryService, ClockProvider, StartupHook],
  routes: customersRoutes,
  imports: [],
  exports: []
});
