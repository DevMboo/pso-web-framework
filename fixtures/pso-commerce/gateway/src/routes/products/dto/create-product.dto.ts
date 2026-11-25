import { Dto, Required, StringField, IntegerField, MinLength, MaxLength, Min } from "@pso/http";

@Dto()
export class CreateProductDto {
  @Required() @StringField() @MinLength(2) @MaxLength(40)
  sku!: string;

  @Required() @StringField() @MinLength(2) @MaxLength(120)
  name!: string;

  @Required() @IntegerField() @Min(0)
  priceCents!: number;

  @Required() @IntegerField() @Min(0)
  stock!: number;
}
