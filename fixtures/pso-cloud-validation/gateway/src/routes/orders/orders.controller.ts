import { Controller, RestController, Post, Req, Res, Upstream, Get, Param } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";

@Controller()
@RestController("/orders")
export class OrdersController {
  constructor(private readonly upstream: Upstream) {}

  @Post("/")
  async create(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "orders");
  }

  @Get("/:id")
  async findOne(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "orders");
  }
}
