import "reflect-metadata";
import { PsoUploadedFile, checkFile, normalizeFileSpec, type FileOptions, type FileSpec, type FilesOptions } from "./files.ts";
import { headOf } from "./multipart.ts";

/**
 * Declarative DTO validation. A route opts in explicitly with `@Body(MyDto)`; `@Body()` keeps its old meaning (parsed JSON, untouched).
 * Rules come from decorators on the DTO fields (real runtime metadata, never the erased TypeScript types). Nothing is coerced: a string is
 * not a number. Unknown properties are rejected unless the DTO says `@Dto({ unknown: "strip" })`. Validation of the SHAPE is pure and synchronous;
 * business rules that need services (uniqueness, existence) are separate `@Validate(Class)` validators, registered as providers and resolved
 * through the framework container, and they run only after the whole structure is valid.
 */
export const V = { dto: "pso:dto", fields: "pso:dto:fields" } as const;

type DtoClass = abstract new (...args: never[]) => unknown;
export type DtoRef = DtoClass | (() => DtoClass);
type Kind = "string" | "integer" | "number" | "boolean" | "email" | "date" | "enum" | "array" | "object" | "file";
type ItemType = "string" | "integer" | "number" | "boolean" | "email" | "date" | DtoClass;

export interface ValidationContext {
  /** the DTO object being validated (declared fields only, already structurally valid) */
  readonly object: Readonly<Record<string, unknown>>;
  /** dotted path of the field being validated, e.g. `address.city` or `tags[2]` */
  readonly path: string;
}
/** A business validator. Return a message to reject, or nothing to accept. It may be async and may use injected services. */
export interface FieldValidator { validate(value: unknown, ctx: ValidationContext): string | undefined | void | Promise<string | undefined | void> }
type ValidatorClass = new (...args: never[]) => FieldValidator;

interface FieldSpec {
  name: string; optional: boolean; nullable: boolean; kind?: Kind;
  minLength?: number; maxLength?: number; min?: number; max?: number; pattern?: RegExp; values?: ReadonlyArray<string | number>;
  minItems?: number; maxItems?: number; item?: ItemType; nested?: DtoRef;
  validators: ValidatorClass[]; message?: string; file?: FileSpec;
}
interface DtoOptions { unknown: "reject" | "strip" }

export interface FieldError { field?: string; message: string }
export class ValidationError extends Error {
  readonly errors: FieldError[];
  readonly truncated: boolean;
  constructor(errors: FieldError[], truncated = false) { super("validation_failed"); this.errors = errors; this.truncated = truncated; }
}
/** thrown while the application starts (a mistake in a DTO declaration), never per request */
export class DtoDeclarationError extends Error {}

export const MAX_DEPTH = 8;
export const MAX_ERRORS = 50;
export const DEFAULT_MAX_ITEMS = 1000;
export const HARD_MAX_ITEMS = 10_000;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

// ------------------------------------------------------------------ declaration
const fieldsOf = (cls: object): Map<string, FieldSpec> => {
  const own = Reflect.getOwnMetadata(V.fields, cls) as Map<string, FieldSpec> | undefined;
  if (own) return own;
  const inherited = Reflect.getMetadata(V.fields, cls) as Map<string, FieldSpec> | undefined;
  const copy = new Map<string, FieldSpec>([...(inherited ?? new Map())].map(([k, v]) => [k, { ...v, validators: [...v.validators] }]));
  Reflect.defineMetadata(V.fields, copy, cls);
  return copy;
};
const spec = (target: object, key: string | symbol): FieldSpec => {
  if (typeof key !== "string" || FORBIDDEN.has(key)) throw new DtoDeclarationError(`"${String(key)}" cannot be a DTO field`);
  const fields = fieldsOf(target.constructor);
  let s = fields.get(key);
  if (!s) { s = { name: key, optional: false, nullable: false, validators: [] }; fields.set(key, s); }
  return s;
};
const field = (f: (s: FieldSpec) => void) => (target: object, key: string | symbol): void => f(spec(target, key));
const setKind = (kind: Kind) => field((s) => { if (s.kind && s.kind !== kind && !(s.kind === "string" && kind === "email")) throw new DtoDeclarationError(`field "${s.name}" already has the type ${s.kind}; choose one type decorator`); s.kind = kind; });

/** Marks a class as a validated DTO. Required for every class used in `@Body(...)`, `@Nested(...)` and `@ArrayOf(...)`. */
export const Dto = (options: Partial<DtoOptions> = {}) => (target: DtoClass): void => {
  if (options.unknown !== undefined && options.unknown !== "reject" && options.unknown !== "strip") throw new DtoDeclarationError('unknown must be "reject" or "strip"');
  Reflect.defineMetadata(V.dto, { unknown: options.unknown ?? "reject" } satisfies DtoOptions, target);
  fieldsOf(target);
};
export const isDto = (cls: unknown): boolean => typeof cls === "function" && Reflect.getMetadata(V.dto, cls) !== undefined;

export const Required = () => field((s) => { if (s.optional) throw new DtoDeclarationError(`field "${s.name}" is both @Required and @Optional`); s.optional = false; });
export const Optional = () => field((s) => { s.optional = true; });
/** Accepts an explicit JSON null (an absent field is still governed by Required/Optional). */
export const Nullable = () => field((s) => { s.nullable = true; });
export const StringField = () => setKind("string");
export const IntegerField = () => setKind("integer");
export const NumberField = () => setKind("number");
export const BooleanField = () => setKind("boolean");
export const Email = () => setKind("email");
/** A UUID in canonical form (8-4-4-4-12 hexadecimal digits, any version). The value stays a string. */
export const Uuid = () => field((s) => { if (s.kind && s.kind !== "string") throw new DtoDeclarationError(`field "${s.name}" already has the type ${s.kind}; choose one type decorator`); s.kind = "string"; s.pattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; });
/** ISO 8601 date (YYYY-MM-DD) or date-time with a zone (Z or ±hh:mm). The value stays a string. */
export const IsoDate = () => setKind("date");
/**
 * A file received in a `multipart/form-data` request (`PsoUploadedFile`). Limits are enforced while the body streams; the declared content
 * type is checked against the file signature. Declaring a file field makes `@Body(Dto)` accept multipart instead of JSON.
 */
export const FileField = (options: FileOptions = {}) => field((s) => { setFile(s, options, false); });
/** Several files in one field (`PsoUploadedFile[]`), limited by `maxFiles`. */
export const FilesField = (options: FilesOptions = {}) => field((s) => { setFile(s, options, true); });
function setFile(s: FieldSpec, o: FilesOptions, multiple: boolean): void {
  if (s.kind && s.kind !== "file") throw new DtoDeclarationError(`field "${s.name}" already has the type ${s.kind}; choose one type decorator`);
  try { s.file = normalizeFileSpec(o, multiple); } catch (e) { throw new DtoDeclarationError(`field "${s.name}": ${(e as Error).message}`); }
  s.kind = "file";
  s.optional = o.required === false;
}
export const OneOf = (...values: Array<string | number>) => field((s) => { if (values.length === 0) throw new DtoDeclarationError("OneOf needs at least one value"); s.kind = "enum"; s.values = values; });
export const Nested = (dto: DtoRef) => field((s) => { s.kind = "object"; s.nested = dto; });
export const ArrayOf = (item: ItemType) => field((s) => { s.kind = "array"; s.item = item; });
export const MinLength = (n: number) => field((s) => { s.minLength = n; });
export const MaxLength = (n: number) => field((s) => { s.maxLength = n; });
export const Min = (n: number) => field((s) => { s.min = n; });
export const Max = (n: number) => field((s) => { s.max = n; });
export const MinItems = (n: number) => field((s) => { s.minItems = n; });
export const MaxItems = (n: number) => field((s) => { if (n > HARD_MAX_ITEMS) throw new DtoDeclarationError(`MaxItems cannot exceed ${HARD_MAX_ITEMS}`); s.maxItems = n; });
export const Pattern = (re: RegExp) => field((s) => { if (re.global || re.sticky) throw new DtoDeclarationError("Pattern must not use the g or y flag (it is stateful)"); s.pattern = re; });
/** Replaces the messages of this field with your own text (a constant: never put request data in it). */
export const Message = (text: string) => field((s) => { s.message = text; });
/** Business validator resolved from the container. The class must be listed in the module providers. */
export const Validate = (validator: ValidatorClass) => field((s) => { s.validators.push(validator); });

// ------------------------------------------------------------------ introspection used by the runtime and the documentation tools
export function dtoFields(cls: DtoClass): Array<{ name: string; kind: Kind | undefined; optional: boolean }> {
  return [...fieldsOf(cls).values()].map((f) => ({ name: f.name, kind: f.kind, optional: f.optional }));
}
/** The file fields of a DTO (top level only), keyed by name. Empty for a plain JSON DTO. */
export function fileFieldsOf(cls: DtoClass): Map<string, FileSpec> {
  const out = new Map<string, FileSpec>();
  for (const f of fieldsOf(cls).values()) if (f.kind === "file" && f.file) out.set(f.name, f.file);
  return out;
}
/** The unknown-property policy of a DTO. */
export const unknownPolicyOf = (cls: DtoClass): "reject" | "strip" => (Reflect.getMetadata(V.dto, cls) as DtoOptions | undefined)?.unknown ?? "reject";
/** Declared fields with the information needed to read them from a multipart form. */
export function formFieldsOf(cls: DtoClass): Array<{ name: string; kind: Kind | undefined; item: ItemType | undefined; values: ReadonlyArray<string | number> | undefined }> {
  return [...fieldsOf(cls).values()].filter((f) => f.kind !== "file").map((f) => ({ name: f.name, kind: f.kind, item: f.item, values: f.values }));
}
/** Every validator class reachable from the DTO tree, for registration checks at start-up. */
export function validatorsOf(cls: DtoClass, seen = new Set<unknown>()): ValidatorClass[] {
  if (seen.has(cls)) return [];
  seen.add(cls);
  const out: ValidatorClass[] = [];
  for (const f of fieldsOf(cls).values()) {
    out.push(...f.validators);
    const n = f.nested ? deref(f.nested) : typeof f.item === "function" ? f.item : undefined;
    if (n) out.push(...validatorsOf(n, seen));
  }
  return out;
}
/** Declaration problems of a DTO tree (not decorated, nested class not a DTO, ...). Empty when sound. */
export function checkDeclaration(cls: DtoClass, seen = new Set<unknown>(), path = cls.name): string[] {
  if (seen.has(cls)) return [];
  seen.add(cls);
  const problems: string[] = [];
  if (!isDto(cls)) return [`${path} is used as a DTO but is not decorated with @Dto()`];
  for (const f of fieldsOf(cls).values()) {
    if (!f.kind) problems.push(`${path}.${f.name} has no type decorator (use @StringField(), @IntegerField(), @Email(), @Nested(...), ...)`);
    if (f.kind === "array" && f.item === undefined) problems.push(`${path}.${f.name} is an array without an item type`);
    const n = f.nested ? deref(f.nested) : typeof f.item === "function" ? f.item : undefined;
    if (n) {
      problems.push(...checkDeclaration(n, seen, `${path}.${f.name}`));
      if (fileFieldsOf(n).size > 0) problems.push(`${path}.${f.name}: file fields are supported only at the top level of a DTO`);
    }
    if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) problems.push(`${path}.${f.name}: MinLength is greater than MaxLength`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) problems.push(`${path}.${f.name}: Min is greater than Max`);
  }
  return problems;
}
/** A DtoRef is the class itself or an arrow function returning it (for mutually referencing DTOs); arrow functions have no prototype. */
const deref = (r: DtoRef): DtoClass => ((r as { prototype?: unknown }).prototype === undefined ? (r as () => DtoClass)() : (r as DtoClass));

// ------------------------------------------------------------------ validation
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/;
function validEmail(v: string): boolean { return v.length <= 254 && v.indexOf("@") <= 64 && EMAIL.test(v) && !v.includes(".."); }
function validIsoDate(v: string): boolean {
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59)) return false;
  return true;
}
const safeKey = (k: string): string => k.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
const join = (path: string, name: string): string => (path ? `${path}.${name}` : name);

interface Run { errors: FieldError[]; truncated: boolean; pending: Array<() => Promise<void>>; resolve: (v: ValidatorClass) => FieldValidator }
const add = (r: Run, path: string, message: string): void => {
  if (r.errors.length >= MAX_ERRORS) { r.truncated = true; return; }
  r.errors.push({ ...(path ? { field: path } : {}), message });
};

function checkScalar(r: Run, f: FieldSpec, kind: Kind | "item", itemKind: ItemType | undefined, v: unknown, path: string): boolean {
  const k = (kind === "item" ? itemKind : kind) as string;
  const fail = (m: string): false => { add(r, path, f.message ?? m); return false; };
  switch (k) {
    case "string": case "email": case "date": {
      if (typeof v !== "string") return fail("must be a string");
      if (k === "email" && !validEmail(v)) return fail("must be a valid e-mail address");
      if (k === "date" && !validIsoDate(v)) return fail("must be an ISO 8601 date or date-time");
      if (f.minLength !== undefined && [...v].length < f.minLength) return fail(`must have at least ${f.minLength} character${f.minLength === 1 ? "" : "s"}`);
      if (f.maxLength !== undefined && [...v].length > f.maxLength) return fail(`must have at most ${f.maxLength} characters`);
      if (f.pattern && !f.pattern.test(v)) return fail("has an invalid format");
      return true;
    }
    case "integer": case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return fail(k === "integer" ? "must be an integer" : "must be a number");
      if (k === "integer" && !Number.isSafeInteger(v)) return fail("must be an integer");
      if (f.min !== undefined && v < f.min) return fail(`must be at least ${f.min}`);
      if (f.max !== undefined && v > f.max) return fail(`must be at most ${f.max}`);
      return true;
    }
    case "boolean": return typeof v === "boolean" ? true : fail("must be a boolean");
    case "enum": return (f.values as ReadonlyArray<unknown>).includes(v) ? true : fail(`must be one of: ${f.values!.join(", ")}`);
    default: return fail("has an unsupported type");
  }
}

function validateObject(r: Run, cls: DtoClass, input: unknown, path: string, depth: number): Record<string, unknown> | undefined {
  if (depth > MAX_DEPTH) { add(r, path, `is nested deeper than ${MAX_DEPTH} levels`); return undefined; }
  if (typeof input !== "object" || input === null || Array.isArray(input)) { add(r, path, "must be an object"); return undefined; }
  const opts = Reflect.getMetadata(V.dto, cls) as DtoOptions;
  const specs = fieldsOf(cls);
  const out = Object.create(cls.prototype as object | null) as Record<string, unknown>;
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (!specs.has(key) && opts.unknown === "reject") add(r, join(path, safeKey(key)), "is not allowed");
  }
  for (const f of specs.values()) {
    const p = join(path, f.name);
    if (!Object.hasOwn(src, f.name) || src[f.name] === undefined) { if (!f.optional) add(r, p, f.message ?? "is required"); continue; }
    const v = src[f.name];
    if (v === null) { if (f.nullable) { out[f.name] = null; } else add(r, p, f.message ?? "must not be null"); continue; }
    let ok: boolean;
    if (f.kind === "file") {
      const spec = f.file!;
      const list = Array.isArray(v) ? v : [v];
      if (!spec.multiple && Array.isArray(v)) { add(r, p, f.message ?? "must be a single file"); continue; }
      if (!list.every((x) => x instanceof PsoUploadedFile)) { add(r, p, f.message ?? "must be an uploaded file (send multipart/form-data)"); continue; }
      if (list.length > spec.maxFiles) { add(r, p, f.message ?? `must have at most ${spec.maxFiles} file${spec.maxFiles === 1 ? "" : "s"}`); continue; }
      if (spec.multiple && list.length < spec.minFiles) { add(r, p, f.message ?? `must have at least ${spec.minFiles} file${spec.minFiles === 1 ? "" : "s"}`); continue; }
      ok = true;
      for (const [i, x] of (list as PsoUploadedFile[]).entries()) {
        const problem = checkFile(spec, x, headOf(x));
        if (problem) { add(r, spec.multiple ? `${p}[${i}]` : p, f.message ?? problem); ok = false; }
      }
      if (ok) out[f.name] = spec.multiple ? list : list[0];
    } else if (f.kind === "object") {
      const nested = validateObject(r, deref(f.nested!), v, p, depth + 1);
      ok = nested !== undefined; if (ok) out[f.name] = nested;
    } else if (f.kind === "array") {
      if (!Array.isArray(v)) { add(r, p, f.message ?? "must be an array"); continue; }
      const max = f.maxItems ?? DEFAULT_MAX_ITEMS;
      if (v.length > max) { add(r, p, f.message ?? `must have at most ${max} items`); continue; }
      if (f.minItems !== undefined && v.length < f.minItems) { add(r, p, f.message ?? `must have at least ${f.minItems} item${f.minItems === 1 ? "" : "s"}`); continue; }
      const items: unknown[] = [];
      let all = true;
      for (let i = 0; i < v.length; i++) {
        const ip = `${p}[${i}]`;
        if (typeof f.item === "function") { const o = validateObject(r, f.item, v[i], ip, depth + 1); if (o === undefined) all = false; else items.push(o); }
        else if (checkScalar(r, { ...f, minLength: undefined, maxLength: undefined, min: undefined, max: undefined } as FieldSpec, "item", f.item, v[i], ip)) items.push(v[i]);
        else all = false;
      }
      ok = all; if (ok) out[f.name] = items;
    } else {
      ok = checkScalar(r, f, f.kind!, undefined, v, p);
      if (ok) out[f.name] = v;
    }
    if (ok && f.validators.length > 0) for (const vc of f.validators) r.pending.push(async () => {
      const msg = await r.resolve(vc).validate(out[f.name], { object: out, path: p });
      if (typeof msg === "string" && msg) add(r, p, msg);
    });
  }
  return out;
}

/**
 * Validates `input` against the DTO. Returns an instance of the class (created without running its constructor) that carries only the declared,
 * valid fields. Throws ValidationError with field errors (values are never echoed). Business validators run only when the structure is valid.
 */
export async function validateDto<T>(cls: abstract new (...args: never[]) => T, input: unknown, resolve: (v: ValidatorClass) => FieldValidator = (v) => { throw new DtoDeclarationError(`validator ${v.name} is not registered`); }): Promise<T> {
  const r: Run = { errors: [], truncated: false, pending: [], resolve };
  const value = validateObject(r, cls, input, "", 0);
  if (r.errors.length === 0) for (const job of r.pending) { await job(); if (r.errors.length >= MAX_ERRORS) break; }
  if (r.errors.length > 0 || value === undefined) throw new ValidationError(r.errors, r.truncated);
  return value as T;
}

// ------------------------------------------------------------------ path and query parameters (explicit, strict coercion)
export interface ParamSpec {
  type?: "string" | "integer" | "number" | "boolean";
  required?: boolean; default?: string | number | boolean;
  min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: RegExp; oneOf?: ReadonlyArray<string | number>;
}
const INT = /^-?(0|[1-9]\d*)$/, NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** Converts and checks one path/query value. The conversion is the one the spec asks for and nothing else ("12abc" is an error, never 12). */
export function validateParam(label: string, raw: string | undefined, s: ParamSpec, isPath: boolean): { value: unknown; errors: FieldError[] } {
  const field = (m: string): { value: unknown; errors: FieldError[] } => ({ value: undefined, errors: [{ field: label, message: m }] });
  if (raw === undefined || raw === "") {
    if (s.default !== undefined) return { value: s.default, errors: [] };
    if (s.required ?? isPath) return field("is required");
    return { value: undefined, errors: [] };
  }
  const t = s.type ?? "string";
  let value: unknown = raw;
  if (t === "integer") { if (!INT.test(raw) || !Number.isSafeInteger(Number(raw))) return field("must be an integer"); value = Number(raw); }
  else if (t === "number") { if (!NUM.test(raw) || !Number.isFinite(Number(raw))) return field("must be a number"); value = Number(raw); }
  else if (t === "boolean") { if (raw !== "true" && raw !== "false") return field("must be true or false"); value = raw === "true"; }
  else {
    if (s.minLength !== undefined && [...raw].length < s.minLength) return field(`must have at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && [...raw].length > s.maxLength) return field(`must have at most ${s.maxLength} characters`);
    if (s.pattern && (s.pattern.global || s.pattern.sticky ? false : !s.pattern.test(raw))) return field("has an invalid format");
  }
  if (typeof value === "number") {
    if (s.min !== undefined && value < s.min) return field(`must be at least ${s.min}`);
    if (s.max !== undefined && value > s.max) return field(`must be at most ${s.max}`);
  }
  if (s.oneOf && !s.oneOf.includes(value as string | number)) return field(`must be one of: ${s.oneOf.join(", ")}`);
  return { value, errors: [] };
}
