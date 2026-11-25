import { Injectable } from "@pso/http";
import type { CreateUserDto } from "../dto/request/create-user.dto";

@Injectable()
export class UsersService {
  findAll() { return [{ id: "1", name: "ada" }]; }
  findById(id: string) { return { id }; }
  create(dto: CreateUserDto) { return { id: "2", ...dto }; }
  remove(id: string) { return { removed: id }; }
}
