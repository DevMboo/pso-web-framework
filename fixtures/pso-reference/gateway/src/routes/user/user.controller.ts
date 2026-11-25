import { Controller, RestController, Get, Req, Res, Upstream } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";

@Controller()
@RestController("/accounts/users")
export class UserController {
  constructor(private readonly upstream: Upstream) {}

  @Get("/")
  async findAll(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "accounts");
  }
}
