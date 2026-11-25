import { defineModule } from "@pso/core";
import ordersRoutes from "./ROUTES.pso";
import { OrdersController } from "./orders.controller";
import { OrderChannel } from "./order.channel";
import { OrderAccess } from "./order-access";

export default defineModule({
  name: "orders",
  controllers: [OrdersController],
  providers: [OrderAccess],
  channels: [OrderChannel],
  routes: ordersRoutes,
  imports: [],
  exports: []
});
