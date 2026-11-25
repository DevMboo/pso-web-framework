import type { PsoApi } from "@pso/frontend";
import { createOperations } from "../models/contract.generated.ts";
import type { CreateCustomer, CustomerStatus } from "../models/customer.ts";

/**
 * Every call this microfrontend makes to the backend: operations of the orchestrator's contract, through the `api` the host provides.
 * Operation ids, path parameters, request bodies and success responses are typed from `pso frontend:contracts`.
 */
export const customersService = (api: PsoApi) => {
  const ops = createOperations(api);
  return {
    findAll: (signal?: AbortSignal) => ops.call("GET /customers", signal ? { signal } : {}),
    findById: (id: string, signal?: AbortSignal) => ops.call("GET /customers/:id", { params: { id }, ...(signal ? { signal } : {}) }),
    create: (data: CreateCustomer) => ops.call("POST /customers", { body: data }),
    setStatus: (id: string, status: CustomerStatus) => ops.call("PATCH /customers/:id/status", { params: { id }, body: { status } }),
  };
};
export type CustomersService = ReturnType<typeof customersService>;
