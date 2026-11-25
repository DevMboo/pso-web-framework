---
title: Contracts
description: Versioned JSON contracts between services, the route contract that gates exposure, the drift check that keeps both copies honest, and how to evolve a contract safely.
order: 9
keywords: [contract, json, semver, drift, PSO_CONTRACT_DRIFT, PSO_CONTRACT_UNKNOWN_SERVICE]
related: [microservices/service-contracts, getting-started/first-endpoint, orchestrator/routes]
---
PSO uses two kinds of contract.

## Service contracts

A JSON file that states which operations a service offers. Services never share domain entities; they agree on contracts. `pso make:resource` writes the contract twice: in the gateway and as a mirror inside the service.

```json title="orchestrators/gateway/src/.app/contracts/product.contract.json (generated)"
{
  "name": "product",
  "version": "0.1.0",
  "service": "catalog",
  "operations": [
    { "id": "productList", "method": "GET", "path": "/products" }
  ]
}
```

Validation checks the shape, a semantic `version`, unique operation ids, that `service` names a declared service (`PSO_CONTRACT_UNKNOWN_SERVICE`) and that the copy mirrored into the service has not drifted (`PSO_CONTRACT_DRIFT`).

### Seeing drift

Edit the version in one copy only and validate (Expected output):

```text evidence="expected"
ERROR   PSO_CONTRACT_DRIFT orchestrators/gateway/src/.app/contracts/product.contract.json: Contract "product" differs from its copy in service "catalog"
        hint: Update both copies together (pso make:resource --force regenerates them)
FAILED
```

`validate` exits with code 1. The check exists because the two teams (or the same person on two days) will otherwise change one side and not the other.

## The route contract

`ROUTES.pso.ts` is a contract between the orchestrator's controllers and the outside world. Method, path, controller, action and security policy must all agree with the decorators, or the route is denied. See [Routing](/orchestrator/routes).

## Evolving a contract

| Change | Version | Effect on clients |
|---|---|---|
| add an operation | minor | none; new capability |
| add an optional field to a response | minor | none |
| rename or remove an operation or field | major | breaks clients; coordinate and keep the old one for a while |
| fix documentation or metadata | patch | none |

Always change both copies in the same commit (regenerating with `--force` rewrites them together; review the diff first). Dispatch events have their own lock and compatibility rules: [event contracts](/dispatch/contracts).

## What contracts are not

They are not an OpenAPI replacement and do not validate bodies at run time; they describe the operations the gateway exposes and let tooling check consistency. Run-time body validation is the job of [DTO validation](/orchestrator/dto-validation) in the gateway and Jakarta Validation in the service.

## Common mistakes

- Editing only the gateway copy.
- Pointing `service` at a name that is not in `pso.workspace.json`.
- Reusing an operation id for a different path.

## Next steps

- [Service contracts](/microservices/service-contracts)
- [First endpoint](/getting-started/first-endpoint)
