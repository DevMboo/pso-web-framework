import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Dto, Required, Optional, Nullable, StringField, Uuid, IntegerField, NumberField, BooleanField, Email, IsoDate, OneOf, Nested, ArrayOf,
  MinLength, MaxLength, Min, Max, MinItems, MaxItems, Pattern, Message, Validate,
  validateDto, validateParam, checkDeclaration, validatorsOf, ValidationError, DtoDeclarationError, MAX_ERRORS, MAX_DEPTH,
  type FieldValidator,
} from "../src/index.ts";

// decorators are applied by call here (the test runner strips types but does not transform decorator syntax); generated projects use the @ syntax
type Dec = (target: object, key: string) => void;
function define(cls: new () => unknown, fields: Record<string, Dec[]>, unknown?: "reject" | "strip"): void {
  Dto(unknown ? { unknown } : {})(cls as never);
  for (const [name, decs] of Object.entries(fields)) for (const d of [...decs].reverse()) d(cls.prototype as object, name);
}
type Errs = Array<{ field?: string; message: string }>;
const errorsOf = async (cls: new () => unknown, input: unknown, resolve?: () => FieldValidator): Promise<Errs> => {
  try { await validateDto(cls, input, resolve as never); return []; } catch (e) { if (e instanceof ValidationError) return e.errors; throw e; }
};

class Address { street!: string; city!: string }
class CreateUser { name!: string; email!: string; age?: number; role!: string; tags?: string[]; address?: Address; birthday?: string; active?: boolean }
define(Address, { street: [Required(), StringField(), MinLength(1)], city: [Required(), StringField(), MaxLength(40)] });
define(CreateUser, {
  name: [Required(), StringField(), MinLength(3), MaxLength(20)],
  email: [Required(), Email()],
  age: [Optional(), IntegerField(), Min(18), Max(120)],
  role: [Required(), OneOf("admin", "user")],
  tags: [Optional(), ArrayOf("string"), MaxItems(3)],
  address: [Optional(), Nested(Address)],
  birthday: [Optional(), IsoDate()],
  active: [Optional(), BooleanField()],
});
const valid = { name: "Ana", email: "ana@example.com", role: "user" };

test("a valid body becomes an instance of the DTO class with only the declared fields and no constructor call", async () => {
  let constructed = 0;
  class Spy { constructor() { constructed++; } v!: string }
  define(Spy, { v: [Required(), StringField()] });
  const out = await validateDto(Spy, { v: "x" });
  assert.ok(out instanceof Spy); assert.equal(constructed, 0, "the constructor never runs"); assert.equal(out.v, "x");
  const u = await validateDto(CreateUser, { ...valid, age: 30, tags: ["a", "b"], address: { street: "Main", city: "Lisbon" }, birthday: "2000-02-29", active: false });
  assert.ok(u instanceof CreateUser);
  assert.equal(u.name, "Ana"); assert.equal(u.age, 30); assert.deepEqual(u.tags, ["a", "b"]); assert.equal(u.address?.city, "Lisbon"); assert.equal(u.birthday, "2000-02-29"); assert.equal(u.active, false);
});

test("every constraint reports a field path and a message that never contains the submitted value", async () => {
  const e = await errorsOf(CreateUser, { name: "Al", email: "not-an-email", age: 17.5, role: "root", tags: ["a", 2, "c", "d"], address: { street: "", city: 5 }, birthday: "2023-02-30", active: "yes" });
  const by = Object.fromEntries(e.map((x) => [x.field, x.message]));
  assert.equal(by["name"], "must have at least 3 characters");
  assert.equal(by["email"], "must be a valid e-mail address");
  assert.equal(by["age"], "must be an integer");
  assert.equal(by["role"], "must be one of: admin, user");
  assert.equal(by["tags"], "must have at most 3 items");
  assert.equal(by["address.street"], "must have at least 1 character");
  assert.equal(by["address.city"], "must be a string");
  assert.equal(by["birthday"], "must be an ISO 8601 date or date-time");
  assert.equal(by["active"], "must be a boolean");
  assert.ok(!JSON.stringify(e).includes("not-an-email") && !JSON.stringify(e).includes("root"), "values are never echoed");
  assert.deepEqual((await errorsOf(CreateUser, { ...valid, age: 17 })).map((x) => x.message), ["must be at least 18"]);
  assert.deepEqual((await errorsOf(CreateUser, { ...valid, tags: ["a", 2] })).map((x) => [x.field, x.message]), [["tags[1]", "must be a string"]]);
  assert.deepEqual((await errorsOf(CreateUser, {})).map((x) => [x.field, x.message]), [["name", "is required"], ["email", "is required"], ["role", "is required"]]);
});

test("no coercion: strings are not numbers, null is not absent, wrong shapes are rejected", async () => {
  assert.deepEqual((await errorsOf(CreateUser, { ...valid, age: "30" })).map((x) => x.message), ["must be an integer"]);
  assert.deepEqual((await errorsOf(CreateUser, { ...valid, age: null })).map((x) => x.message), ["must not be null"]);
  assert.deepEqual((await errorsOf(CreateUser, { ...valid, active: 1 })).map((x) => x.message), ["must be a boolean"]);
  for (const bad of [null, [], "text", 5]) assert.deepEqual((await errorsOf(CreateUser, bad)).map((x) => x.message), ["must be an object"]);
  class N { n!: number; z?: string | null }
  define(N, { n: [Required(), NumberField()], z: [Optional(), Nullable(), StringField()] });
  assert.deepEqual(await errorsOf(N, { n: 1.5, z: null }), []);
  assert.deepEqual((await errorsOf(N, { n: Infinity })).map((x) => x.message), ["must be a number"]);
});

test("unknown properties: rejected by default, stripped only when the DTO says so; prototype pollution keys never pass", async () => {
  assert.deepEqual((await errorsOf(CreateUser, { ...valid, isAdmin: true })).map((x) => [x.field, x.message]), [["isAdmin", "is not allowed"]]);
  const polluted = JSON.parse('{"name":"Ana","email":"ana@example.com","role":"user","__proto__":{"isAdmin":true},"constructor":{"x":1}}') as unknown;
  const e = await errorsOf(CreateUser, polluted);
  assert.deepEqual(e.map((x) => x.field).sort(), ["__proto__", "constructor"]);
  class Lenient { name!: string }
  define(Lenient, { name: [Required(), StringField()] }, "strip");
  const out = await validateDto(Lenient, JSON.parse('{"name":"a","extra":1,"__proto__":{"polluted":true}}') as unknown);
  assert.equal(out.name, "a");
  assert.deepEqual(Object.keys(out), ["name"]);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined, "Object.prototype is untouched");
  assert.equal((out as unknown as Record<string, unknown>)["polluted"], undefined);
  assert.throws(() => Required()(Object.prototype, "__proto__"), DtoDeclarationError);
  const long = await errorsOf(CreateUser, { ...valid, ["x".repeat(500) + "\u0007"]: 1 });
  assert.ok(long[0]!.field!.length <= 64 && !/[\u0000-\u001f]/.test(long[0]!.field!), "echoed property names are bounded and sanitised");
});

test("limits: error count, nesting depth and array size are bounded", async () => {
  class Row { id!: number }
  define(Row, { id: [Required(), IntegerField()] });
  class Bulk { rows!: Row[] }
  define(Bulk, { rows: [Required(), ArrayOf(Row)] });
  try { await validateDto(Bulk, { rows: Array.from({ length: 200 }, () => ({ id: "x" })) }); assert.fail("expected an error"); }
  catch (e) { assert.ok(e instanceof ValidationError); assert.equal(e.errors.length, MAX_ERRORS); assert.equal(e.truncated, true); }
  assert.deepEqual((await errorsOf(Bulk, { rows: new Array(1001).fill({ id: 1 }) })).map((x) => x.message), ["must have at most 1000 items"]);
  class Node1 { child?: Node1 }
  define(Node1, { child: [Optional(), Nested(() => Node1)] });
  let deep: Record<string, unknown> = {}; for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { child: deep };
  assert.match((await errorsOf(Node1, deep))[0]!.message, /nested deeper than/);
  assert.throws(() => MaxItems(1_000_000)({}, "x"), DtoDeclarationError);
});

test("declaration mistakes are found at start-up: undecorated nested class, missing type, two types, stateful pattern", () => {
  class Plain { x!: string }
  class Holder { p!: Plain; a!: string; b!: string[] }
  define(Holder, { p: [Required(), Nested(Plain)], a: [Required()], b: [Required(), ArrayOf("string")] });
  const problems = checkDeclaration(Holder);
  assert.ok(problems.some((p) => /Holder.p is used as a DTO but is not decorated/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /Holder\.a has no type decorator/.test(p)), problems.join("; "));
  assert.deepEqual(checkDeclaration(CreateUser), []);
  assert.throws(() => { class T { x!: unknown } Dto()(T as never); StringField()(T.prototype, "x"); IntegerField()(T.prototype, "x"); }, DtoDeclarationError);
  assert.throws(() => Pattern(/a/g)({}, "x"), DtoDeclarationError);
  assert.throws(() => { class T { x!: unknown } Optional()(T.prototype, "x"); Required()(T.prototype, "x"); }, DtoDeclarationError);
});

test("Pattern, Message, inheritance and optional fields behave as declared", async () => {
  class Base { code!: string }
  define(Base, { code: [Required(), StringField(), Pattern(/^[A-Z]{3}$/), Message("must be a 3-letter code")] });
  class Child extends Base { note?: string }
  Dto()(Child as never); Optional()(Child.prototype, "note"); StringField()(Child.prototype, "note");
  assert.deepEqual((await errorsOf(Child, { code: "ab" })).map((x) => x.message), ["must be a 3-letter code"]);
  assert.deepEqual(await errorsOf(Child, { code: "ABC" }), []);
  assert.deepEqual(await errorsOf(Base, { code: "ABC", note: "x" }), [{ field: "note", message: "is not allowed" }], "the parent does not gain the child's fields");
  class Mi { items!: string[] }
  define(Mi, { items: [Required(), ArrayOf("string"), MinItems(2)] });
  assert.deepEqual((await errorsOf(Mi, { items: ["a"] })).map((x) => x.message), ["must have at least 2 items"]);
});

test("business validators run only after the structure is valid, may be async, receive the object and the path, and are resolved by the caller", async () => {
  const calls: string[] = [];
  class UniqueEmail implements FieldValidator {
    readonly taken: Set<string>;
    constructor(taken: Set<string>) { this.taken = taken; }
    async validate(value: unknown, ctx: { object: Readonly<Record<string, unknown>>; path: string }): Promise<string | undefined> {
      calls.push(`${ctx.path}:${String(ctx.object["name"])}`);
      await new Promise((r) => setTimeout(r, 1));
      return this.taken.has(value as string) ? "is already registered" : undefined;
    }
  }
  const instance = new UniqueEmail(new Set(["taken@example.com"]));
  class Signup { name!: string; email!: string }
  define(Signup, { name: [Required(), StringField()], email: [Required(), Email(), Validate(UniqueEmail as never)] });
  assert.deepEqual(validatorsOf(Signup), [UniqueEmail]);
  const resolve = (): FieldValidator => instance;
  assert.deepEqual(await errorsOf(Signup, { name: "Ana", email: "taken@example.com" }, resolve), [{ field: "email", message: "is already registered" }]);
  assert.deepEqual(calls, ["email:Ana"]);
  assert.deepEqual(await errorsOf(Signup, { name: "Ana", email: "free@example.com" }, resolve), []);
  calls.length = 0;
  assert.equal((await errorsOf(Signup, { name: 5, email: "taken@example.com" }, resolve)).length, 1);
  assert.deepEqual(calls, [], "no business validator runs while the structure is invalid (no query for garbage input)");
  await assert.rejects(validateDto(Signup, { name: "Ana", email: "free@example.com" }), /not registered/);
});

test("path and query parameters: explicit strict conversion, defaults and ranges", () => {
  const v = (raw: string | undefined, s: Parameters<typeof validateParam>[2], path = false) => validateParam("query.page", raw, s, path);
  assert.deepEqual(v("12", { type: "integer", min: 1, max: 100 }), { value: 12, errors: [] });
  assert.equal(v("12abc", { type: "integer" }).errors[0]!.message, "must be an integer");
  assert.equal(v("012", { type: "integer" }).errors.length, 1, "no leading zeros");
  assert.equal(v("101", { type: "integer", max: 100 }).errors[0]!.message, "must be at most 100");
  assert.deepEqual(v(undefined, { type: "integer", default: 1 }), { value: 1, errors: [] });
  assert.deepEqual(v(undefined, { type: "integer" }), { value: undefined, errors: [] });
  assert.equal(v(undefined, { type: "integer" }, true).errors[0]!.message, "is required", "path parameters are required");
  assert.deepEqual(v("true", { type: "boolean" }), { value: true, errors: [] });
  assert.equal(v("TRUE", { type: "boolean" }).errors.length, 1);
  assert.equal(v("1e3", { type: "number" }).errors.length, 1);
  assert.equal(v("x", { oneOf: ["asc", "desc"] }).errors[0]!.message, "must be one of: asc, desc");
  assert.equal(v("abc", { pattern: /^\d+$/ }).errors[0]!.message, "has an invalid format");
});

test("Uuid: canonical UUIDs only, still a string, no coercion", async () => {
  class Sub { candidateId!: string }
  define(Sub, { candidateId: [Required(), Uuid()] });
  assert.deepEqual(await errorsOf(Sub, { candidateId: "3f2a7c9e-1d4b-4e8a-9b6c-0a1b2c3d4e5f" }), []);
  for (const bad of ["x", "3f2a7c9e1d4b4e8a9b6c0a1b2c3d4e5f", "3f2a7c9e-1d4b-4e8a-9b6c-0a1b2c3d4e5g", 5, null, "3f2a7c9e-1d4b-4e8a-9b6c-0a1b2c3d4e5f" + String.fromCharCode(10)]) assert.equal((await errorsOf(Sub, { candidateId: bad })).length, 1, JSON.stringify(bad));
});
