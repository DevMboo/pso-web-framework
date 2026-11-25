import { Dto, Required, OneOf } from "@pso/http";

@Dto()
export class CustomerStatusDto {
  @Required() @OneOf("ACTIVE", "SUSPENDED")
  status!: "ACTIVE" | "SUSPENDED";
}
