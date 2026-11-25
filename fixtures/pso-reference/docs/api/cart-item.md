# CartItem

`POST /catalog/cart-items` served by **catalog** through **gateway**.

- Access: guard `jwt`, scopes cart:write
- Declaration: `gateway/src/routes/cart-item/ROUTES.pso.ts` (module `cart-item`)
- Contract: `gateway/src/contracts/cart-item.contract.json` (mirrored in `catalog/src/main/resources/contracts/`)
- Controller: `catalog/src/main/java/com/pso/catalog/routes/CartItemController.java`
