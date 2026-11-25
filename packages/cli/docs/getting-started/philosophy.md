---
title: Architectural philosophy
description: Structure declares, modules compose, contracts validate, the framework executes - each principle shown in a concrete behavior you can reproduce, with its cost.
order: 3
keywords: [philosophy, principles, deny by default, static discovery, determinism]
related: [concepts/path-structure-working, decisions/why-directory-conventions, concepts/security-by-default, concepts/declarative-architecture]
---
> **Structure declares. Modules compose. Contracts validate. The framework executes.**

| Verb | Meaning in PSO |
|---|---|
| **Structure declares** | Directories and file names say what a file is. `src/modules/users/` is a module; `*.guard.ts` is a guard. |
| **Modules compose** | `MODULE.pso.ts` lists the controllers and providers that belong together. |
| **Contracts validate** | `ROUTES.pso.ts`, JSON service contracts and the workspace schema are checked against the code before anything runs. |
| **The framework executes** | `bootstrap()` validates once more, wires dependencies and activates only what was declared. |

## Seven principles, each one observable

### 1. Convention over configuration, with explicit configuration when convention is not enough

A new orchestrator has a fixed layout (`src/modules`, `src/.app/guards`, `src/.app/middlewares`, ...). You do not configure where controllers live; you put them there. When a convention is not enough (a port, an upstream address, a limit) there is one documented place to set it ([configuration](/concepts/configuration)).

*Cost:* the layout is not negotiable. A team that wants a different tree is fighting the tools.

### 2. Static discovery

`pso validate` reads TypeScript and Java **without executing** it. You can run it on code you do not trust yet, in CI, before dependencies are installed.

```text evidence="expected"
$ pso validate
catalog: 12 resource(s), digest f4307ea2aac8
gateway: 12 resource(s), digest e010c0bcf740
OK
```
*(expected output for a new workspace with the reference CRUD; digests vary with the structure)*

*Cost:* what cannot be seen statically cannot be validated. A route built at run time from a loop is invisible to the tooling, so it is not allowed.

### 3. Deny by default

Nothing is public or reachable unless it says so. A route with no policy fails validation; a request without a token to a guarded route is refused:

```text evidence="expected"
GET /customers   (no token)                     -> 401 PSO_AUTH_UNAUTHORIZED
GET /customers   (token without the scope)      -> 403 PSO_AUTH_FORBIDDEN
```
*(expected output; see [First endpoint](/getting-started/first-endpoint))*

*Cost:* the first request you make to a new route fails until you give it a token. That is the feature.

### 4. Explicit contracts between services

Services do not share domain classes. They share a small JSON contract, written once on each side and checked for drift (`PSO_CONTRACT_DRIFT`). Two teams can change their internals freely as long as the contract holds.

*Cost:* some duplication of shapes. It is the price of independent deployment.

### 5. Declared, not scanned

Discovery never implies authorization. A controller class that exists is not a controller that is registered, and a registered controller is not an exposed endpoint. Three separate declarations are needed, and the decorators alone do none of them:

```text evidence="illustrative"
DELETE /customers/1   (decorated in the controller, absent from ROUTES.pso.ts)   -> 404 PSO_HTTP_NOT_FOUND
```
*(expected output)*

*Cost:* adding an endpoint is two edits (the generator makes both). A forgotten registration shows up as a visible `404`.

### 6. Deterministic

Discovery is sorted, manifests are reproducible (the digest in the `validate` output above is stable for the same input), and generators never overwrite your files silently. Running a command twice gives the same result.

### 7. Declared exposure

An annotation describes a method; a registry file decides whether it is reachable. This separation is why code review of one small file answers "what did this change expose?".

## How the principles pull in one direction

| If you ask | The answer comes from |
|---|---|
| what services exist? | `pso.workspace.json` (declared) |
| what endpoints are reachable? | the `ROUTES.pso.ts` files (declared) |
| who may call them? | the route's security policy (declared, default deny) |
| does the code match? | `pso validate` (static) |
| what actually runs? | `bootstrap()` (the same validation, then activation) |

## Where the principles stop

They are not a promise that your application is correct. They make one kind of mistake hard (inconsistent wiring and accidental exposure). Business logic, data modelling and performance remain yours; see [Why PSO exists](/getting-started/why-pso) for what the framework does not do.

## Next steps

- The reasoning and trade-offs of each choice: [Architecture decisions](/decisions/why-directory-conventions)
- Apply it: [Quick start](/getting-started/quick-start)

## Common mistakes

- Treating "deny by default" as friction to be configured away on day one.
- Fighting the conventions instead of using the generators that place files for you.
- Reading the principles as guarantees about your own code: they protect wiring and exposure, not business logic.
