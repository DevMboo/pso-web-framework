import { Controller, RestController, Get, Req, Res, Upstream } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";

@Controller()
@RestController("/catalog/products")
export class ProductController {
  constructor(private readonly upstream: Upstream) {}

  @Get("/")
  async findAll(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "catalog");
  }
}
