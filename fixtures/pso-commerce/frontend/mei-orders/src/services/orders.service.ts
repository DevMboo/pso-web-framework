import type { PsoApi } from "@pso/frontend";
import { createOperations } from "../models/contract.generated.ts";
import type { PlaceOrder } from "../models/order.ts";

/** Every call this microfrontend makes to the backend: typed operations of the orchestrator's contract, through the `api` the host provides. */
export const ordersService = (api: PsoApi) => {
  const ops = createOperations(api);
  return {
    findAll: (signal?: AbortSignal) => ops.call("GET /orders", signal ? { signal } : {}),
    findById: (id: string, signal?: AbortSignal) => ops.call("GET /orders/:id", { params: { id }, ...(signal ? { signal } : {}) }),
    /** a POST: the client never repeats it automatically (an order must not be placed twice by a retry) */
    place: (data: PlaceOrder) => ops.call("POST /orders", { body: data }),
  };
};
export type OrdersService = ReturnType<typeof ordersService>;
