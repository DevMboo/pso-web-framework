import { Injectable, UpstreamClient } from "@pso/http";

export interface Customer { id: string; name: string; email: string; status: string }
export interface Order { id: string; productId: string; quantity: number; unitPriceCents: number; totalCents: number; status: string }
export interface Product { id: string; sku: string; name: string; priceCents: number }
export interface CustomerSummary { customer: Customer; orders: Array<Order & { product: Pick<Product, "sku" | "name"> | null }>; orderCount: number; totalCents: number }

/** Coordinates three services into one answer. The rules of each domain stay in its service: nothing is recomputed here but a sum. */
@Injectable()
export class SummaryService {
  constructor(private readonly services: UpstreamClient) {}

  async of(customerId: string): Promise<CustomerSummary> {
    const [customer, orders] = await Promise.all([
      this.services.get<Customer>("customers", "/customers/:id", { params: { id: customerId }, credentials: "caller" }),
      this.services.get<Order[]>("orders", "/orders", { query: { customerId }, credentials: "caller", timeoutMs: 5000 }),
    ]);
    const ids = [...new Set(orders.map((o) => o.productId))];
    const products = new Map((await Promise.all(ids.map((id) => this.services.get<Product>("catalog", "/products/:id", { params: { id }, credentials: "caller" })))).map((p) => [p.id, p]));
    return {
      customer,
      orders: orders.map((o) => ({ ...o, product: products.has(o.productId) ? { sku: products.get(o.productId)!.sku, name: products.get(o.productId)!.name } : null })),
      orderCount: orders.length,
      totalCents: orders.reduce((sum, o) => sum + o.totalCents, 0),
    };
  }
}
