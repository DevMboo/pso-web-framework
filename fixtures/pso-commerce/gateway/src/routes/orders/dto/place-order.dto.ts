import { Dto, Required, StringField, IntegerField, Min, Max } from "@pso/http";

@Dto()
export class PlaceOrderDto {
  @Required() @StringField()
  customerId!: string;

  @Required() @StringField()
  productId!: string;

  @Required() @IntegerField() @Min(1) @Max(1000)
  quantity!: number;
}
