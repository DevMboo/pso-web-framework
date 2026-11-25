# Products

`GET /products` served by **catalog** through **gateway**.

- Access: guard `jwt`, scopes catalog:read
- Declaration: `gateway/src/routes/products/ROUTES.pso.ts` (module `products`)
- Contract: `gateway/src/contracts/products.contract.json` (mirrored in `catalog/src/main/resources/contracts/`)
- Controller: `catalog/src/main/java/com/pso/catalog/routes/ProductsController.java`
