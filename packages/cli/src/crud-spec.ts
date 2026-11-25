import { NAME_PATTERNS } from "@pso/core";
import { CliError } from "./fsx.ts";
import { camel, pascal } from "./templates.ts";

/**
 * The resource model of a generated CRUD: one description, rendered into the Spring microservice (entity, migration, DTO records,
 * validation, persistence, service, controller, tests) and into the orchestrator module (DTOs, contract, provider, service, controller,
 * routes). The reference Product CRUD of every new project is PRODUCT; `pso make:crud <name> --fields ...` builds other resources.
 */
export type FieldType = "string" | "text" | "integer" | "long" | "decimal" | "boolean";

export interface FieldSpec {
  /** camelCase property name; the column is its snake_case form */
  name: string;
  type: FieldType;
  required: boolean;
  /** strings: length limits */
  minLength?: number; maxLength?: number;
  /** integer/long/decimal: value limits (decimal limits are strings to keep their exact value) */
  min?: string; max?: string;
  /** decimal precision and scale (NUMERIC(precision, scale)) */
  precision?: number; scale?: number;
  /** a database UNIQUE constraint (and a 409 Conflict on duplicates) */
  unique?: boolean;
  /** strings: allowed characters, as a regular expression source (anchored by the generators) */
  pattern?: string;
  /** a human sentence for the pattern violation */
  patternMessage?: string;
  /** booleans: the value when the field is omitted on creation */
  defaultValue?: boolean;
  /** listed in the allowed sort fields */
  sortable?: boolean;
  /** filterable on the list endpoint: "contains" (case-insensitive) for strings, "equals" for unique strings and booleans */
  filter?: "contains" | "equals";
  /** shown in descriptions and the documentation */
  description?: string;
}

export interface ResourceSpec {
  /** kebab-case singular: product, order-line */
  name: string;
  /** kebab-case plural used in paths and the table name: products */
  plural: string;
  fields: FieldSpec[];
  /** largest page size of the list endpoint */
  maxPageSize: number;
  defaultPageSize: number;
}

export const names = (r: ResourceSpec) => ({
  Resource: pascal(r.name), resource: camel(r.name), Resources: pascal(r.plural), resources: camel(r.plural),
  path: `/${r.plural}`, table: r.plural.replace(/-/g, "_"), kebab: r.name, kebabPlural: r.plural,
  readScope: `${r.plural}:read`, writeScope: `${r.plural}:write`,
});
export const column = (f: FieldSpec): string => f.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The reference Product resource of every new PSO application. */
export const PRODUCT: ResourceSpec = {
  name: "product", plural: "products", maxPageSize: 100, defaultPageSize: 20,
  fields: [
    { name: "sku", type: "string", required: true, minLength: 3, maxLength: 64, unique: true, pattern: "[A-Z0-9][A-Z0-9-]*[A-Z0-9]", patternMessage: "must contain only upper-case letters, digits and inner hyphens (for example KB-100)", sortable: true, filter: "equals", description: "stock keeping unit, unique" },
    { name: "name", type: "string", required: true, minLength: 1, maxLength: 120, sortable: true, filter: "contains", description: "display name" },
    { name: "description", type: "text", required: false, maxLength: 2000, description: "optional long description" },
    { name: "price", type: "decimal", required: true, precision: 12, scale: 2, min: "0.00", max: "9999999999.99", sortable: true, description: "unit price, exact decimal with 2 fraction digits" },
    { name: "active", type: "boolean", required: false, defaultValue: true, sortable: false, filter: "equals", description: "only active products are sold" },
  ],
};

/**
 * Parses `--fields`: comma-separated `name:type[:option]...`
 *   types     string | text | integer | long | decimal | boolean
 *   options   optional | unique | min=N | max=N | length=MIN-MAX | precision=P | scale=S | default=true|false | sort | filter
 * Example: --fields "code:string:unique:length=2-32:filter:sort,title:string:max=200:filter,quantity:integer:min=0,amount:decimal:precision=12:scale=2,enabled:boolean:default=true:filter"
 */
export function parseFields(raw: string): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, type, ...opts] = part.split(":").map((s) => s.trim());
    if (!name || !/^[a-z][A-Za-z0-9]*$/.test(name)) throw new CliError(`Invalid field name "${name ?? ""}" in "${part}"`, "Use camelCase, e.g. unitPrice");
    if (["id", "createdAt", "updatedAt", "version"].includes(name)) throw new CliError(`"${name}" is generated for every resource; do not declare it`);
    if (out.some((f) => f.name === name)) throw new CliError(`field "${name}" is declared twice`);
    if (!type || !["string", "text", "integer", "long", "decimal", "boolean"].includes(type)) throw new CliError(`Invalid type "${type ?? ""}" for field "${name}"`, "Use string, text, integer, long, decimal or boolean");
    const f: FieldSpec = { name, type: type as FieldType, required: true };
    for (const o of opts) {
      const [k, v] = o.split("=");
      if (k === "optional") f.required = false;
      else if (k === "unique") { if (f.type !== "string") throw new CliError(`unique applies to string fields ("${name}")`); f.unique = true; }
      else if (k === "sort") f.sortable = true;
      else if (k === "filter") f.filter = f.type === "boolean" || f.unique ? "equals" : f.type === "string" ? "contains" : (() => { throw new CliError(`filter applies to string and boolean fields ("${name}")`); })();
      else if ((k === "min" || k === "max") && v !== undefined && /^-?\d+(\.\d+)?$/.test(v)) {
        // strings: a length limit; numbers: a value limit; booleans: nothing to limit
        if (f.type === "boolean") throw new CliError(`${k} does not apply to boolean field "${name}"`);
        if (f.type === "string" || f.type === "text") { if (!/^\d+$/.test(v)) throw new CliError(`${k} of "${name}" is a length: a whole number`); if (k === "min") f.minLength = Number(v); else f.maxLength = Number(v); }
        else { if ((f.type === "integer" || f.type === "long") && !/^-?\d+$/.test(v)) throw new CliError(`${k} of "${name}" must be a whole number`); f[k] = v; }
      }
      else if (k === "length" && v && /^\d+-\d+$/.test(v)) { const [a, b] = v.split("-").map(Number); f.minLength = a; f.maxLength = b; }
      else if (k === "precision" && v && /^\d+$/.test(v)) f.precision = Number(v);
      else if (k === "scale" && v && /^\d+$/.test(v)) f.scale = Number(v);
      else if (k === "default" && (v === "true" || v === "false")) { if (f.type !== "boolean") throw new CliError(`default applies to boolean fields ("${name}")`); f.defaultValue = v === "true"; f.required = false; }
      else throw new CliError(`Unknown option "${o}" for field "${name}"`, "Options: optional, unique, min=N, max=N, length=MIN-MAX, precision=P, scale=S, default=true|false, sort, filter");
    }
    if (f.type === "string" && f.maxLength === undefined) f.maxLength = 255;
    if (f.type === "text" && f.maxLength === undefined) f.maxLength = 10_000;
    if (f.type === "decimal") { f.precision ??= 12; f.scale ??= 2; if (f.scale > f.precision) throw new CliError(`scale cannot exceed precision for "${name}"`); }
    if (f.unique) f.filter = "equals";
    out.push(f);
  }
  if (!out.length) throw new CliError("--fields declares no field");
  return out;
}

/** A resource from CLI input: kebab-case name, optional plural and fields (defaults: one required `name` string). */
export function resourceFrom(name: string, plural: string | undefined, fields: string | undefined): ResourceSpec {
  if (!NAME_PATTERNS.kebab.test(name)) throw new CliError(`Invalid resource name "${name}"`, "Use a kebab-case singular noun, e.g. order or order-line");
  const pl = plural ?? (name.endsWith("y") && !/[aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`);
  if (!NAME_PATTERNS.kebab.test(pl)) throw new CliError(`Invalid plural "${pl}"`, "Pass --plural <kebab-case>");
  if (pl === name) throw new CliError(`The plural of "${name}" must differ from it`, "Pass --plural <kebab-case>");
  return {
    name, plural: pl, maxPageSize: 100, defaultPageSize: 20,
    fields: fields ? parseFields(fields) : [{ name: "name", type: "string", required: true, minLength: 1, maxLength: 120, sortable: true, filter: "contains" }],
  };
}

/** Fields the list endpoint may sort by (always includes createdAt and updatedAt). */
export const sortFields = (r: ResourceSpec): string[] => [...r.fields.filter((f) => f.sortable).map((f) => f.name), "createdAt", "updatedAt"];
