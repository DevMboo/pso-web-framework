---
title: Service contracts
description: Versioned JSON contracts mirrored into each service and checked for drift - what is generated, what is validated, how to change one safely, and what contracts deliberately do not cover.
order: 4
keywords: [contract, json, drift, make:resource, version, PSO_CONTRACT_DRIFT]
related: [concepts/contracts, getting-started/first-endpoint, orchestrator/dto-validation, spring/postgresql-crud]
---
`pso make:resource customer --service catalog --route /customers` creates the contract in two places:

```text evidence="verified"
created    gateway/src/.app/contracts/customer.contract.json
created    catalog/src/main/java/com/pso/catalog/application/dto/response/CustomerResponse.java
created    catalog/src/main/java/com/pso/catalog/application/rest/CustomerController.java
created    catalog/src/main/resources/contracts/customer.contract.json
created    catalog/src/test/java/com/pso/catalog/application/rest/CustomerControllerTests.java
created    docs/api/customer.md
created    gateway/src/modules/customer/MODULE.pso.ts
created    gateway/src/modules/customer/controllers/customer.controller.ts
created    gateway/src/modules/customer/routes/ROUTES.pso.ts
```

The two contract files (`gateway/src/.app/contracts/` and `catalog/src/main/resources/contracts/`) are identical copies; the rest of the output is the Spring controller and response record (in the layered packages), its test, an API note and the orchestrator module that go with them. A JSON contract is the shared, versioned description of a forwarding resource; a module that calls its service through `UpstreamClient` (the reference CRUD, `make:crud`) types that API in `modules/<module>/contracts/<name>.contract.ts` instead.

```json title="customer.contract.json (generated)"
{
  "name": "customer",
  "version": "0.1.0",
  "service": "catalog",
  "operations": [{ "id": "customerList", "method": "GET", "path": "/customers" }]
}
```

## Validation

`pso validate` checks that the contract is valid JSON of the expected shape, has a semantic version, unique operation ids and a `service` that is declared in the workspace, and that the two copies are byte-identical (`PSO_CONTRACT_DRIFT` otherwise). Reproduced here by changing `version` in the gateway copy only: changing `version` in the gateway copy only makes `pso validate` print

```text evidence="verified"
ERROR   PSO_CONTRACT_DRIFT gateway/src/.app/contracts/customer.contract.json: Contract "customer" differs from its copy in service "catalog"
        hint: Update both copies together (pso make:resource --force regenerates them)
gateway: 5 resource(s), digest 90d8f1f4cc8a
catalog: 6 resource(s), digest 986a7750032c
FAILED
```

and exit with code 1. Regenerating with `--force` rewrites the copy you changed (`overwritten gateway/src/.app/contracts/customer.contract.json`; the other files are reported `unchanged`) and `pso validate` is `OK` again.

## Changing a contract: step by step

1. Decide whether the change is observable by callers (add an operation, rename a path) or not (documentation).
2. Edit **both** copies, or regenerate: `pso make:resource customer --service catalog --route /customers --force` (review the diff before committing; `--force` overwrites what the generator owns).
3. Bump `version`: minor for additions, major for removals or renames, patch for metadata.
4. Run `pso validate`: it must print `OK`.
5. Change the Spring controller and the gateway route in the same commit, so the three agree.

## Variations

| Need | Contract change |
|---|---|
| a new read endpoint | add an operation with a new `id`, bump minor |
| two services expose the same resource name | give each its own contract file; `name` and `service` identify the pair |
| a deprecated operation | keep it for a release, mark the replacement; remove with a major bump |

## What contracts do not cover

Contracts describe **operations**, not payload schemas. Payloads are defined by the Spring DTOs (with Jakarta Validation) and, when the gateway answers a request itself, by `@Dto` classes ([DTO validation](/orchestrator/dto-validation)). The two are not cross-checked against the contract in this version, so a payload change needs its own review.

## Common mistakes

- Editing one copy.
- Reusing an operation id for a different method or path.
- Treating a green `validate` as proof that the payloads match.

## Next steps

- [Contracts (concept)](/concepts/contracts)
- [First endpoint](/getting-started/first-endpoint)
