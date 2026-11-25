import { Controller, RestController, Get, Post, Delete, Param, Body } from "@pso/http";
import { UsersService } from "../services/users.service";
import { CreateUserDto } from "../dto/request/create-user.dto";

@Controller()
@RestController("/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("/")
  async findAll() { return this.usersService.findAll(); }

  @Get("/:id")
  async findById(@Param("id") id: string) { return this.usersService.findById(id); }

  @Post("/")
  async create(@Body(CreateUserDto) dto: CreateUserDto) { return this.usersService.create(dto); }

  // decorated but NOT declared in ROUTES.pso.ts: must never become an endpoint
  @Delete("/:id")
  async remove(@Param("id") id: string) { return this.usersService.remove(id); }
}
