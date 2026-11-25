import type { CreateCustomerDto, CustomerResponse, CustomerStatusDto } from "./contract.generated.ts";

/** A customer as the orchestrator publishes it (response contract of GET /customers/:id): generated, never hand-maintained. */
export type Customer = CustomerResponse;
/** Request types come from the orchestrator's own DTOs (pso frontend:contracts): no hand-maintained copy to drift. */
export type CreateCustomer = CreateCustomerDto;
export type CustomerStatus = CustomerStatusDto["status"];
