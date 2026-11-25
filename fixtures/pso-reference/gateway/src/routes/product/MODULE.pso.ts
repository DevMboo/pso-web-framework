import { defineModule } from "@pso/core";
import productRoutes from "./ROUTES.pso";
import { ProductController } from "./product.controller";

export default defineModule({
  name: "product",
  controllers: [ProductController],
  providers: [],
  routes: productRoutes,
  imports: [],
  exports: []
});
