import { defineModule } from "@pso/core";
import customersRoutes from "./ROUTES.pso";
import { CustomersController } from "./customers.controller";

export default defineModule({
  name: "customers",
  controllers: [CustomersController],
  providers: [],
  routes: customersRoutes,
  imports: [],
  exports: []
});
