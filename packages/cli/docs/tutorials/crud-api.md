---
title: Build a CRUD API
description: The generated Product CRUD from the first command to real requests - what each layer does, one request followed from the client through the orchestrator's route, controller, service and provider to the Spring controller, service, repository and PostgreSQL, then a second resource generated the same way.
order: 2
status: stable
keywords: [tutorial, crud, products, postgresql, flyway, jpa, validation, pagination, filtering, orchestrator, provider, upstream, jwt, make:crud]
prerequisites: [Node 24 or newer, JDK 21, Docker, the pso CLI]
related: [architecture/reference-crud, architecture/overview, architecture/typescript-orchestrator, architecture/java-microservice, architecture/generators, spring/postgresql-crud]
---
New PSO projects start with a complete, tested Product API: a Spring Boot microservice that owns the data in PostgreSQL, and the
orchestrator module that publishes it. This tutorial creates it, follows one request through every layer, calls the API, and then
generates a second resource with the same structure. Nothing here is written by hand: every file is generated and every answer shown
was returned by a real run.

```architecture title="One request through the layers"
client (client)
  orchestrator, Node, :3000 (orchestrator) # route, guard, controller, service, provider
    catalog, Spring Boot, :8081 (service) # controller, service, repository
      PostgreSQL (database)
```

## 1. Create the workspace

```bash
pso create workspace shop
cd shop
pso create service catalog
pso create orchestrator gateway
pso validate
```

`create service` writes the layered Spring service with the Product CRUD and declares that it needs PostgreSQL; `create orchestrator`
writes the modular orchestrator and binds its `products` module to `catalog`, the service of this workspace that serves `/products`
(it prints `reference CRUD: module "products" bound to service "catalog"`). `--template empty` creates either project without the
example. [The reference CRUD](/architecture/reference-crud) lists every file.

## 2. The request lifecycle, layer by layer

Follow `POST /products` with a token that holds `products:write`.

**1. The route** decides that the URL exists, who may call it, and which services its action may call. Nothing that is not declared
here is reachable, whatever a controller's decorators say.

```ts title="gateway/src/modules/products/routes/ROUTES.pso.ts"
{ method: "POST", path: "/products", controller: ProductController, action: "create", security: { guard: "jwt", scopes: ["products:write"] }, metadata: { services: ["catalog"] }, responses: { 201: "ProductResponse", 400: "problem", 409: "problem" } },
```

The `jwt` guard (`src/.app/guards/jwt.guard.ts`) validates the token against the identity provider's JWKS and checks the scope: a
missing token is `401`, a missing scope `403`, before any code of the module runs.

**2. The controller** validates the body against its DTO (unknown properties, types, lengths, the money format: a `400` lists every
field at fault) and answers `201` with a `Location` header:

```ts title="gateway/src/modules/products/controllers/product.controller.ts"
  @Post("/")
  async create(@Body(CreateProductDto) body: CreateProductDto) {
    const product = await this.products.create(body);
    return created(product, `/products/${product.id}`);
  }
```

**3. The service** coordinates: it calls the provider and maps the answer to the public response. It persists nothing and does not
repeat the rules the microservice owns.

```ts title="gateway/src/modules/products/services/product.service.ts"
  async create(body: CreateProductDto): Promise<ProductResponse> {
    return toProductResponse(await this.provider.create(toWrite(body)));
  }
```

**4. The provider** calls the microservice **by name**. `UpstreamClient` resolves `catalog` through service discovery (no URL in
code), applies its endpoint prefix (`/catalog`), uses its TLS material, propagates the correlation id and the trace, and forwards the
caller's token because the call asks for it (`credentials: "caller"`) and the route declared the service. A `404`, `409` or `400` of
the service becomes the same problem here; a service that is down becomes a stable `502`/`503`/`504`.

```ts title="gateway/src/modules/products/providers/product.provider.ts"
  create(body: ProductWrite): Promise<ProductRecord> {
    return translate(this.client.post<ProductRecord>(PRODUCT_SERVICE, "/products", body, { credentials: "caller" }));
  }
```

`PRODUCT_SERVICE` is the binding constant of `contracts/product.contract.ts`; `pso crud:bind products --to <service>` changes it
together with the routes' `metadata.services`.

**5. The Spring controller** receives `/catalog/products`. The PSO security starter validates the same token again and
`@PreAuthorize` checks the same scope: bypassing the orchestrator gains nothing.

```java title="catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java"
    @PostMapping
    @PreAuthorize("hasAuthority('SCOPE_products:write')")
    public ResponseEntity<ProductResponse> create(@Valid @RequestBody CreateProductRequest request) {
        ProductResponse created = service.create(request);
        URI location = ServletUriComponentsBuilder.fromCurrentRequestUri().path("/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }
```

**6. The Spring service** is the transaction boundary. It checks the SKU, maps the request to an entity and writes it at once, so a
violation of the unique constraint (two requests racing past the check) is reported inside this transaction as a `409`:

```java title="catalog/src/main/java/com/pso/catalog/application/service/ProductService.java"
    @Transactional
    public ProductResponse create(CreateProductRequest request) {
        if (repository.existsBySku(request.sku().strip())) {
            throw duplicateSku();
        }
        ProductEntity entity = mapper.toEntity(request);
        return mapper.toResponse(saveAndFlush(entity));
    }
```

**7. The repository** is Spring Data JPA; lists are filtered, sorted and paginated **by the database** through `Specification` and
`Pageable`:

```java title="catalog/src/main/java/com/pso/catalog/infrastructure/persistence/ProductRepository.java"
public interface ProductRepository extends JpaRepository<ProductEntity, UUID>, JpaSpecificationExecutor<ProductEntity> {

    boolean existsBySku(String sku);

    boolean existsBySkuAndIdNot(String sku, UUID id);
}
```

**8. PostgreSQL** holds the table that Flyway created from `src/main/resources/db/migration/V1__create_products.sql`: a UUID key, the
unique SKU constraint, an exact `NUMERIC(12, 2)` price and `TIMESTAMPTZ` timestamps. Hibernate only validates that the entity
matches it (`ddl-auto: validate`).

The answer travels back the same way: entity, response record, `201` from the service, the orchestrator's mapper, `201` with
`Location: /products/<id>` to the client.

## 3. Start it

```bash
pso infra:init --identity keycloak --runtime docker --users "ana,bob:products:read"
pso docker:up --vendor
```

`infra:init` declares the local environment with Keycloak and two development users: `ana` holds every scope the routes declare
(`products:read`, `products:write`), `bob` only `products:read`. `--vendor` copies the PSO packages and Java artifacts the images need into the projects (an installed CLI references them on this machine, which an image build cannot reach); later starts without a rebuild do not need it. `docker:up` generates the certificates, the database password and
the realm into `.infra/` (never into your source), builds the images, starts PostgreSQL, Keycloak, `catalog`, `gateway` and the edge
in dependency order, and waits until each is healthy:

```text evidence="expected"
ready:   api https://api.pso.localhost:8443
```

## 4. Call it

From Studio (`pso studio`, API Client, **Reference requests**: every request of the module, sent with a development user), or with
curl and a development token:

```powershell
$TOKEN = pso infra:token --user ana
curl --cacert .infra/ca/local/ca.crt https://api.pso.localhost:8443/products/options
curl --cacert .infra/ca/local/ca.crt -H "authorization: Bearer $TOKEN" -H "content-type: application/json" `
  -d '{"sku":"KB-100","name":"Keyboard KB-100","description":"Mechanical, 87 keys","price":"49.90","active":true}' `
  https://api.pso.localhost:8443/products
curl --cacert .infra/ca/local/ca.crt -H "authorization: Bearer $TOKEN" "https://api.pso.localhost:8443/products?page=0&size=2&sort=sku,asc"
```

The certificate authority of the local environment is `.infra/ca/local/ca.crt`: TLS is verified, never switched off. The answers of
a real run (identifiers and timestamps as returned):

```text evidence="expected"
GET /products/options   200 {"sort":["sku","name","price","createdAt","updatedAt"],"directions":["asc","desc"],"filters":["sku","name","active"],"maxPageSize":100,"defaultPageSize":20}
POST /products          201 Location: /products/552178c7-02be-4534-9dd4-f0ca5c88b268
                            {"id":"552178c7-02be-4534-9dd4-f0ca5c88b268","sku":"KB-100","name":"Keyboard KB-100","description":"Mechanical, 87 keys","price":"49.90","active":true,"createdAt":"2026-11-24T19:28:17.754309Z","updatedAt":"2026-11-24T19:28:17.754330Z"}
GET /products?page=0&size=2&sort=sku,asc
                        200 {"items":[...2 products...],"page":0,"size":2,"totalItems":4,"totalPages":2}
POST /products (same SKU)
                        409 {"type":"urn:pso:problem:http-conflict","title":"Conflict","status":409,"detail":"a product with this sku already exists","code":"PSO_HTTP_CONFLICT",...}
```

Filters run in the database: `?name=keyboard` (case-insensitive contains), `?sku=KB-100` (exact), `?active=true`. Sorting accepts
the fields `/products/options` lists, with `,asc` or `,desc`; `size` is at most 100. Every error is an RFC 9457 problem: the complete
set of recorded answers (400 with the fields at fault, 401, 403, 404, the 503 while the service is stopped) is on
[the reference CRUD page](/architecture/reference-crud#requests-and-answers).

## 5. A second resource

```bash
pso make:crud order --service catalog --orchestrator --fields "code:string:unique:length=3-32:filter:sort,total:decimal:precision=12:scale=2:min=0:sort,paid:boolean:default=false:filter"
pso validate
pso docker:up --build --vendor
```

`make:crud` writes the same layers for `order` in both projects: the entity, the next migration (`V2__create_orders.sql`) with its
constraints and indexes, repository and filters, request and response records, mapper, transactional service, controller with
`orders:read` / `orders:write`, tests, and the orchestrator's `orders` module with its DTOs, contract, provider, service, mapper,
controller, routes, a public `/orders/options` and a Studio collection. The next reconciliation gives `ana` the new scopes in Keycloak
without a restart. `./mvnw test` and `npm test` run the generated tests of both projects.

## Common mistakes

| Mistake | What you see | Do instead |
|---|---|---|
| a product body with the price as a number | `400`: price must be a decimal string (`"12.50"`) | send money as a string; it stays exact end to end |
| editing `V1__create_products.sql` after it ran | Flyway refuses to start: checksum mismatch | add `V<next>__...` with `pso make:migration` |
| calling `catalog` directly from a client | `401` without a token, and the API's public surface is the orchestrator | call the orchestrator; Studio labels direct requests as diagnostics |
| a second service also created with the reference CRUD | `pso create orchestrator` asks which one with `--crud-service` | create it with `--template empty`, or remove its example |
| `curl -k` to get past TLS | it works, and hides a real certificate problem | `--cacert .infra/ca/local/ca.crt` |

## Next steps

- [The reference CRUD](/architecture/reference-crud): every file, removal, the recorded requests and answers.
- [PostgreSQL, JPA and Flyway](/spring/postgresql-crud) in the generated service.
- [Generators](/architecture/generators) and the `--fields` options of `make:crud`.
- Projects that keep the 0.1 layout: [a CRUD by hand in the 0.1 layout](/architecture/manual-crud-0-1).
