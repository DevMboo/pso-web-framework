---
title: Declarative architecture
description: Data files say what the system is; code says what it does - the five declarations, why they are restricted to literals, and the trade-off against a dynamic route table.
order: 3
keywords: [declarative, registry, data, literals, ROUTES.pso.ts, review]
related: [orchestrator/routes, concepts/module-composition, decisions/why-routes-pso-mandatory, decisions/why-no-code-execution-in-discovery]
---
PSO prefers **declarations that can be read as data** to behavior discovered at runtime.

| Declaration | File | What it fixes |
|---|---|---|
| Services, ports, dependencies | `pso.workspace.json` | the shape of the distributed system |
| Module composition | `MODULE.pso.ts` | which controllers and providers belong together |
| Endpoint registry | `ROUTES.pso.ts` | which endpoints exist and their security policy |
| Service contract | `*.contract.json` | operations a service offers, versioned |
| Configuration | `pso.config.json` layers | typed settings with documented precedence |

## What "restricted" means

`ROUTES.pso.ts` and `MODULE.pso.ts` must use literal values and identifiers (no spread, no computed keys), so they can be verified from the source text.

```typescript
// accepted: literal, readable, verifiable
{ method: "GET", path: "/products", controller: ProductController, action: "findAll", security: { guard: "jwt", scopes: ["products:read"] } }

// not accepted: computed. A tool cannot know what this registers without running it.
...resources.map((r) => ({ method: "GET", path: `/${r}`, controller: Controllers[r], action: "findAll", security: policy }))
```

A dynamic route table would be flexible, but it could not be validated without running it, and could not be reviewed at a glance. The cost is repetition: ten similar routes are ten literal entries (the generators write them for you).

## What you gain

| Question | Where the answer is | Cost to answer |
|---|---|---|
| Which endpoints does this system expose? | the `ROUTES.pso.ts` files, or `pso routes:list` | seconds |
| What did this pull request expose? | the diff of one `ROUTES.pso.ts` | a glance |
| Is the policy of a route what we meant? | the route's `security` member, or `pso security:policy` | a glance |
| Are the pieces consistent? | `pso validate` | one command, no dependencies installed |

```text evidence="verified"
$ pso security:policy
default: deny
GET     /products                guarded:jwt scopes=[products:read]  -> catalog
service catalog: deny by default
```

(For a workspace whose only service is `catalog` with one route; each further service adds its own `service <name>: deny by default` line.)

## The same idea on the Spring side

Spring services follow Spring's conventions (annotations on controllers, `application.yml`), and PSO adds checks around them: the workspace declares the service, the contract declares its operations, `pso.service.prefix` is checked against the workspace. It does not ask Spring services to use a different mechanism.

> [!NOTE]
> A declaration is never a substitute for security. Declaring a route does not authenticate it: every route still needs a guard or an explicit `public: true`.

## When this is the wrong tool

If your routes are genuinely data-driven (a plugin system adds endpoints at run time), a declarative registry fights you. PSO is a poor fit for that case; see [Why PSO exists](/getting-started/why-pso).

## Common mistakes

- Trying to generate `ROUTES.pso.ts` entries in a loop. Use the generator, or write them out.
- Treating the registry as documentation only: it is what the runtime activates.

## Next steps

- [Routing](/orchestrator/routes)
- [Why `ROUTES.pso.ts` is mandatory](/decisions/why-routes-pso-mandatory)
