import { defineModule } from "@pso/core";
import productsRoutes from "./ROUTES.pso";
import { ProductsController } from "./products.controller";

export default defineModule({
  name: "products",
  controllers: [ProductsController],
  providers: [],
  routes: productsRoutes,
  imports: [],
  exports: []
});
