import { Controller, RestController, Get, Req, Res, Upstream, Post, Body, Param, Put, Patch } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";
import { CreateProductDto } from "./dto/create-product.dto";
import { StockChangeDto } from "./dto/stock-change.dto";

@Controller()
@RestController("/products")
export class ProductsController {
  constructor(private readonly upstream: Upstream) {}

  @Get("/")
  async findAll(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "catalog");
  }

  @Post("/")
  async create(@Body(CreateProductDto) _body: CreateProductDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against CreateProductDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "catalog");
  }

  @Get("/:id")
  async findById(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "catalog");
  }

  @Put("/:id")
  async update(@Param("id") id: string, @Body(CreateProductDto) _body: CreateProductDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against CreateProductDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "catalog");
  }

  @Patch("/:id/stock")
  async setStock(@Param("id") id: string, @Body(StockChangeDto) _body: StockChangeDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against StockChangeDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "catalog");
  }

  // FCV check: decorated but NOT declared in ROUTES.pso.ts, so it must not be reachable
  @Get("/internal/debug")
  debug() {
    return { leaked: true };
  }
}
