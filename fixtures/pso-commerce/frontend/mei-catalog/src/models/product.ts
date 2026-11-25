import type { ProductResponse } from "./contract.generated.ts";

/** A product as the orchestrator publishes it (response contract of GET /products/:id): generated. `available` is derived by the catalog service from the stock. */
export type Product = ProductResponse;
/** Availability as published, or derived from the stock when the orchestrator does not publish the flag. */
export const isAvailable = (p: Pick<Product, "stock" | "available">): boolean => p.available ?? p.stock > 0;
import type { CreateProductDto } from "./contract.generated.ts";

/** The request type comes from the orchestrator's own DTO (pso frontend:contracts). */
export type CreateProduct = CreateProductDto;

/** "19.90" or "19,90" to integer cents; undefined when it is not a non-negative amount with at most two decimals. */
export function parsePrice(text: string): number | undefined {
  const m = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
export const formatPrice = (cents: number, locale = "en"): string => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);
