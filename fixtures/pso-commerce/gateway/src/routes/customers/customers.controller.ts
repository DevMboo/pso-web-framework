import { Controller, RestController, Get, Req, Res, Upstream, Post, Body, Param, Put, Patch } from "@pso/http";
import { SummaryService } from "./summary.service";
import { IncomingMessage, ServerResponse } from "node:http";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { CustomerStatusDto } from "./dto/customer-status.dto";

@Controller()
@RestController("/customers")
export class CustomersController {
  constructor(private readonly upstream: Upstream, private readonly summaries: SummaryService) {}

  @Get("/")
  async findAll(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "customers");
  }

  @Post("/")
  async create(@Body(CreateCustomerDto) _body: CreateCustomerDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against CreateCustomerDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "customers");
  }

  @Get("/:id")
  async findById(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "customers");
  }

  @Put("/:id")
  async update(@Param("id") id: string, @Body(UpdateCustomerDto) _body: UpdateCustomerDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against UpdateCustomerDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "customers");
  }

  @Patch("/:id/status")
  async setStatus(@Param("id") id: string, @Body(CustomerStatusDto) _body: CustomerStatusDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    // the body was validated against CustomerStatusDto before this line; forward() sends the request the client sent
    return this.upstream.forward(req, res, "customers");
  }

  @Get("/:id/summary")
  async summary(@Param("id") id: string) {
    return this.summaries.of(id);
  }
}
