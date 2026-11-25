import type { PsoApi } from "@pso/frontend";
import { createOperations } from "../models/contract.generated.ts";
import type { CreateProduct } from "../models/product.ts";

/** Every call this microfrontend makes to the backend: typed operations of the orchestrator's contract, through the `api` the host provides. */
export const productsService = (api: PsoApi) => {
  const ops = createOperations(api);
  return {
    findAll: (signal?: AbortSignal) => ops.call("GET /products", signal ? { signal } : {}),
    findById: (id: string, signal?: AbortSignal) => ops.call("GET /products/:id", { params: { id }, ...(signal ? { signal } : {}) }),
    create: (data: CreateProduct) => ops.call("POST /products", { body: data }),
    setStock: (id: string, stock: number) => ops.call("PATCH /products/:id/stock", { params: { id }, body: { stock } }),
  };
};
export type ProductsService = ReturnType<typeof productsService>;
