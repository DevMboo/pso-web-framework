import { Dto, Required, StringField } from "@pso/http";

@Dto()
export class OrderEventDto {
  @Required() @StringField()
  orderId!: string;

  @Required() @StringField()
  status!: string;
}
