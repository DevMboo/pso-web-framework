import { defineModule } from "@pso/core";
import cartItemRoutes from "./ROUTES.pso";
import { CartItemController } from "./cart-item.controller";

export default defineModule({
  name: "cart-item",
  controllers: [CartItemController],
  providers: [],
  routes: cartItemRoutes,
  imports: [],
  exports: []
});
