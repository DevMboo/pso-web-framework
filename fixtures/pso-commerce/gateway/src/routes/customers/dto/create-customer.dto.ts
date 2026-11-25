import { Dto, Required, StringField, Email, MinLength, MaxLength } from "@pso/http";

@Dto()
export class CreateCustomerDto {
  @Required() @StringField() @MinLength(2) @MaxLength(120)
  name!: string;

  @Required() @Email()
  email!: string;
}
