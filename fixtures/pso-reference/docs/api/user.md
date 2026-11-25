# User

`GET /accounts/users` served by **accounts** through **gateway**.

- Access: guard `jwt`, scopes users:admin
- Declaration: `gateway/src/routes/user/ROUTES.pso.ts` (module `user`)
- Contract: `gateway/src/contracts/user.contract.json` (mirrored in `accounts/src/main/resources/contracts/`)
- Controller: `accounts/src/main/java/com/pso/accounts/routes/UserController.java`
