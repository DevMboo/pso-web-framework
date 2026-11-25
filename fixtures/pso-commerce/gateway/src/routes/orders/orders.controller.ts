import { Controller, RestController, Get, Req, Res, Upstream, Post, Body, Param } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";
import { PlaceOrderDto } from "./dto/place-order.dto";

@Controller()
@RestController("/orders")
export class OrdersController {
  constructor(private readonly upstream: Upstream) {}

  @Get("/")
  async findAll(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "orders");
  }

  @Post("/")
  async place(@Body(PlaceOrderDto) _body: PlaceOrderDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against PlaceOrderDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "orders");
  }

  @Get("/:id")
  async findById(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "orders");
  }
}
