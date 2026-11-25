import { Dto, Required, IntegerField, Min } from "@pso/http";

@Dto()
export class StockChangeDto {
  @Required() @IntegerField() @Min(0)
  stock!: number;
}
