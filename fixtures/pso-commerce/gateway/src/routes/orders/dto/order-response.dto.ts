import { Dto } from "@pso/http";

/** An order as the orders service returns it. Declared in the response contract of the routes that return it (ROUTES.pso.ts `responses`); never used to validate input. */
@Dto()
export class OrderResponse {
  id!: string;
  customerId!: string;
  productId!: string;
  quantity!: number;
  unitPriceCents!: number;
  totalCents!: number;
  status!: string;
  createdBy!: string;
}
