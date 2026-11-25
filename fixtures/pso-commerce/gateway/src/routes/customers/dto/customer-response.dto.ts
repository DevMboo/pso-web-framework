import { Dto } from "@pso/http";

/** A customer as the customers service returns it. Declared in the response contract of the routes that return it (ROUTES.pso.ts `responses`); never used to validate input. */
@Dto()
export class CustomerResponse {
  id!: string;
  name!: string;
  email!: string;
  status!: string;
}
