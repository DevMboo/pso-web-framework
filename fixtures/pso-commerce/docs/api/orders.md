# Orders

`GET /orders` served by **orders** through **gateway**.

- Access: guard `jwt`, scopes orders:read
- Declaration: `gateway/src/routes/orders/ROUTES.pso.ts` (module `orders`)
- Contract: `gateway/src/contracts/orders.contract.json` (mirrored in `orders/src/main/resources/contracts/`)
- Controller: `orders/src/main/java/com/pso/orders/routes/OrdersController.java`
