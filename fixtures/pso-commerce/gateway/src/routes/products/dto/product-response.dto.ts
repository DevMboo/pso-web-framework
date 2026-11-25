import { Dto } from "@pso/http";

/** A product as the catalog service returns it. Declared in the response contract of the routes that return it (ROUTES.pso.ts `responses`); never used to validate input. */
@Dto()
export class ProductResponse {
  id!: string;
  sku!: string;
  name!: string;
  priceCents!: number;
  stock!: number;
  available!: boolean;
}
