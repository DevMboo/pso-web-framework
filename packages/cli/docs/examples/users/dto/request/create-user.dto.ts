import { Dto, Required, Optional, StringField, MinLength, MaxLength, Email, IntegerField, Min } from "@pso/http";

@Dto()
export class CreateUserDto {
  @Required() @StringField() @MinLength(3) @MaxLength(80)
  name!: string;

  @Required() @Email()
  email!: string;

  @Optional() @IntegerField() @Min(18)
  age?: number;
}
