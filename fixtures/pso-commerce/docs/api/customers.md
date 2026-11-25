# Customers

`GET /customers` served by **customers** through **gateway**.

- Access: guard `jwt`, scopes customers:read
- Declaration: `gateway/src/routes/customers/ROUTES.pso.ts` (module `customers`)
- Contract: `gateway/src/contracts/customers.contract.json` (mirrored in `customers/src/main/resources/contracts/`)
- Controller: `customers/src/main/java/com/pso/customers/routes/CustomersController.java`
