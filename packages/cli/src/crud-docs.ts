import { names, sortFields, type ResourceSpec } from "./crud-spec.ts";

/** docs/reference-crud.md of a Spring service: what was generated, where, and how to remove it without damaging the structure. */
export function springCrudDoc(r: ResourceSpec, o: { service: string; pkg: string; prefix: string; files: string[] }): string {
  const n = names(r);
  return `# Reference CRUD: ${n.Resources}

\`pso create service ${o.service}\` generated a complete, working ${n.resource} API as a removable example of the PSO layered structure.
It is real code: PostgreSQL persistence through Flyway and Spring Data JPA, validation, authorization, RFC 9457 errors and tests.

## Endpoints (served at \`${o.prefix}${n.path}\`)

| Method | Path | Scope | Answer |
|---|---|---|---|
| POST | \`${n.path}\` | \`${n.writeScope}\` | 201 + Location, 400 validation_failed, 409 conflict |
| GET | \`${n.path}?page=0&size=${r.defaultPageSize}&sort=createdAt,desc${r.fields.filter((f) => f.filter).map((f) => `&${f.name}=`).join("")}\` | \`${n.readScope}\` | 200 page (max size ${r.maxPageSize}; sort by ${sortFields(r).join(", ")}) |
| GET | \`${n.path}/{id}\` | \`${n.readScope}\` | 200, 404 not_found |
| PUT | \`${n.path}/{id}\` | \`${n.writeScope}\` | 200, 400, 404, 409 |
| DELETE | \`${n.path}/{id}\` | \`${n.writeScope}\` | 204, 404 |

## Files

${o.files.map((f) => `- \`${f}\``).join("\n")}

The shared files (\`shared/exception/*\`, \`shared/validation/PageRequests.java\`, \`application/dto/response/PageResponse.java\`) belong to the
service foundation: keep them, the next resource uses them too.

## Removing the example

1. Delete the files listed above except the shared ones (controller, service, request/response records, mapper, entity, repository,
   specifications, test).
2. The migration \`V*__create_${n.table}.sql\` has already run on every database that started this service. Never delete an applied
   migration: add the next one, \`pso make:migration drop-${n.table} --service ${o.service}\`, with \`DROP TABLE ${n.table};\`. On a fresh
   project that never started against a shared database you may delete the file instead.
3. In the orchestrator, remove \`src/modules/${n.kebabPlural}/\` (its routes go with it), or keep it and rebind it to another service.
4. \`pso validate\` and \`./mvnw test\`.

## Adding another resource the same way

\`\`\`bash
pso make:crud order --service ${o.service} --fields "code:string:unique:length=3-32:filter:sort,total:decimal:precision=12:scale=2:min=0:sort,paid:boolean:default=false:filter"
\`\`\`

It writes the same set of files for the new resource, the next Flyway migration, and (with \`--orchestrator\`) the matching orchestrator module.
`;
}

/** docs/reference-crud.md of the orchestrator. */
export function orchestratorCrudDoc(r: ResourceSpec, o: { orchestrator: string; module: string; service: string; files: string[] }): string {
  const n = names(r);
  return `# Reference CRUD: ${n.Resources} (orchestrator module)

\`pso create orchestrator ${o.orchestrator}\` generated the \`${o.module}\` module: the public ${n.resource} API of the workspace, bound to the
microservice **${o.service}** (the binding is \`${n.kebab.replace(/-/g, "_").toUpperCase()}_SERVICE\` in \`contracts/${n.kebab}.contract.ts\` and
\`metadata.services\` in \`routes/ROUTES.pso.ts\`; \`pso crud:bind ${o.module} --to <service>\` changes both).

## Request lifecycle

\`\`\`text
client / FEI / Studio
  -> ROUTES.pso.ts            route declared? public or jwt + scope (${n.readScope} / ${n.writeScope})
  -> guard + DTO validation    400 before any code runs
  -> ${n.Resource}Controller        controllers/${n.kebab}.controller.ts
  -> ${n.Resource}Service           services/${n.kebab}.service.ts
  -> ${n.Resource}Provider          providers/${n.kebab}.provider.ts  (UpstreamClient: discovery of "${o.service}", TLS/mTLS, caller token, correlation id)
  -> ${o.service}: ${n.Resource}Controller -> ${n.Resource}Service -> ${n.Resource}Repository -> PostgreSQL
\`\`\`

## Endpoints

| Method | Path | Access |
|---|---|---|
| GET | \`${n.path}/options\` | public (answered by the orchestrator alone) |
| GET | \`${n.path}\` | \`${n.readScope}\` |
| GET | \`${n.path}/:id\` | \`${n.readScope}\` |
| POST | \`${n.path}\` | \`${n.writeScope}\` |
| PUT | \`${n.path}/:id\` | \`${n.writeScope}\` |
| DELETE | \`${n.path}/:id\` | \`${n.writeScope}\` |

## Files

${o.files.map((f) => `- \`${f}\``).join("\n")}

## Removing the example

Delete \`src/modules/${o.module}/\` and \`tests/${o.module}/\`, then \`pso validate\`. Nothing else refers to the module: it is discovered from its
directory and registered by its own MODULE.pso.ts.
`;
}
