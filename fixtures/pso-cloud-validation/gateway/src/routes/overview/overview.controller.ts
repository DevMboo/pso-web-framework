import { Controller, RestController, Get, Param, UpstreamClient } from "@pso/http";

interface Order { id: string; customerId: string; productId: string; quantity: number; status: string }
interface Customer { id: string; name: string; email: string }
interface Product { id: string; sku: string; name: string; priceCents: number; stock: number }

@Controller()
@RestController("/overview")
export class OverviewController {
  constructor(private readonly services: UpstreamClient) {}

  /** The state of one order as the three services know it: the order, its customer and the product with the stock that is left. */
  @Get("/orders/:id")
  async show(@Param("id") id: string) {
    const order = await this.services.get<Order>("orders", "/orders/:id", { params: { id }, credentials: "caller" });
    const [customer, product] = await Promise.all([
      this.services.get<Customer>("customers", "/customers/:id", { params: { id: order.customerId }, credentials: "caller" }),
      this.services.get<Product>("catalog", "/products/:id", { params: { id: order.productId }, credentials: "caller" }),
    ]);
    return { order, customer: { id: customer.id, name: customer.name }, product: { id: product.id, name: product.name, stockLeft: product.stock }, totalCents: product.priceCents * order.quantity };
  }
}
