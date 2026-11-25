import { defineModule } from "@pso/core";
import ordersRoutes from "./ROUTES.pso";
import { OrdersController } from "./orders.controller";

export default defineModule({
  name: "orders",
  controllers: [OrdersController],
  providers: [],
  routes: ordersRoutes,
  imports: [],
  exports: []
});
