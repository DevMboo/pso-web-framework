import type { OrderResponse } from "./contract.generated.ts";

/** An order as the orchestrator publishes it (response contract of GET /orders/:id): generated. Amounts are integer cents; `status` starts as PENDING and is decided asynchronously. */
export type Order = OrderResponse;
export const money = (cents: number | undefined, locale = "en"): string => (typeof cents === "number" ? formatMoney(cents, locale) : "—");
import type { PlaceOrderDto } from "./contract.generated.ts";

/** The request type comes from the orchestrator's own DTO (pso frontend:contracts). */
export type PlaceOrder = PlaceOrderDto;
/** The payload of the `order.updated` event of channel `order.<id>`. */
export interface OrderUpdated { orderId: string; status: string }

export const isFinal = (status: string): boolean => status !== "PENDING";
export const formatMoney = (cents: number, locale = "en"): string => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);
export const statusTone = (s: string): "ok" | "warn" | "bad" | "muted" => (s === "CONFIRMED" || s === "PLACED" ? "ok" : s === "PENDING" ? "warn" : s === "REJECTED" || s === "CANCELLED" || s === "FAILED" ? "bad" : "muted");
