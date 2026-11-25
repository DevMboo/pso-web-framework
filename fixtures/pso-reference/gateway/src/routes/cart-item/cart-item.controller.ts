import { Controller, RestController, Post, Req, Res, Upstream } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";

@Controller()
@RestController("/catalog/cart-items")
export class CartItemController {
  constructor(private readonly upstream: Upstream) {}

  @Post("/")
  async create(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "catalog");
  }
}
