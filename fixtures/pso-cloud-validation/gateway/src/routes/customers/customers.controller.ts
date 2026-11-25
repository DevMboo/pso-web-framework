import { Controller, RestController, Post, Req, Res, Upstream, Get, Param } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";

@Controller()
@RestController("/customers")
export class CustomersController {
  constructor(private readonly upstream: Upstream) {}

  @Post("/")
  async create(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "customers");
  }

  @Get("/:id")
  async findOne(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "customers");
  }
}
