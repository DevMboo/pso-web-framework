---
title: Introduction to PSO Web
description: What PSO Web is, which problem it solves, what it automates today, where its limits are, and how to read this documentation.
order: 1
keywords: [overview, introduction, path structure working, orchestrator, microservices]
related: [getting-started/why-pso, concepts/path-structure-working, getting-started/quick-start, reference/choosing-an-approach]
---
**PSO — Path Structure Working** is an approach in which the directory structure of a project, a few declarative files and validated contracts define how the application behaves. **PSO Web** applies it to distributed web applications: a Node.js + TypeScript **orchestrator** in front of Java + Spring Boot **microservices**, driven by one CLI.

> Structure declares. Modules compose. Contracts validate. The framework executes.

## License

PSO Web Framework is free and open-source software, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). It has no telemetry, license check or paid tier ([privacy policy](/downloads/privacy-policy)).

## The problem it solves

Every system made of a public gateway and a few services repeats the same decisions: where files go, how a gateway route reaches the service that implements it, who may call what, how tokens are checked twice, how the whole thing starts on a laptop, and how to find out that a change broke the wiring. Each team re-solves these, differently, and the answers drift apart as the code grows.

PSO makes those decisions once, writes them down as files you can read, and checks them without running your code.

## A picture of the result

```architecture title="Request path of a PSO workspace"
internet (client)
  gateway, the Node orchestrator (orchestrator) # HTTPS | pso.workspace.json declares the gateway and the services; ROUTES.pso.ts decides what is reachable; guards: JWT, scopes, rate limit
    catalog, Spring Boot (service) # forwards, token checked again downstream | owns the data and the business rules
    orders, Spring Boot (service) # forwards, token checked again downstream | owns the data and the business rules
```

:::diagram name="distributed"

## What you can do with it today

| You want to | PSO gives you | Where to learn it |
|---|---|---|
| declare which services exist | a workspace file; services are declared, never found by scanning | [First workspace](/getting-started/first-workspace) |
| expose an endpoint through the gateway | a route that exists only if `ROUTES.pso.ts` declares it, generated together with the Spring side and a contract | [First endpoint](/getting-started/first-endpoint) |
| validate request bodies | `@Body(Dto)` with declarative rules and RFC 9457 errors | [Validate request bodies](/orchestrator/dto-validation) |
| be secure by default | deny by default; JWT checked in the gateway **and** in every service | [Security by default](/concepts/security-by-default) |
| run everything locally | `pso dev`: dependency order, health waiting, logs, graceful stop | [Running the environment](/getting-started/running) |
| store data | Spring Boot with PostgreSQL and Flyway, a tested CRUD example | [PostgreSQL CRUD](/spring/postgresql-crud) |
| exchange events | Dispatch over Redis Streams, RabbitMQ or Kafka, with a transactional outbox | [Event dispatch](/dispatch/overview) |
| see what is happening | readable logs, metrics, traces, Studio | [Logging](/devops/logging), [Observability](/devops/observability) |
| ship it | Docker, deployment descriptors, signed packages and an installer | [Build and deploy](/devops/build-and-deploy), [Distribution](/devops/distribution-and-installation) |

## What it deliberately does not do

- It does not make your business decisions. Business rules and data live in your Spring services.
- It does not hide the frameworks it sits on. Spring is Spring; Node is Node. PSO adds conventions and checks around them.
- It does not publish packages for you, and the `@pso/*` and `com.pso` artifacts are not on public registries yet; you install from a checkout ([Installation](/getting-started/installation)).
- It does not replace an identity provider. It verifies tokens an issuer signs.

> [!WARNING]
> The framework is under active development. Pages say plainly when something is not implemented, and automated tests check the documented commands, options, decorators and environment variables against the code, so this portal does not describe features that do not exist.

## How to read the output in this documentation

Terminal and HTTP output appears in three kinds, always labelled when it matters:

| Label | Meaning |
|---|---|
| **Verified output** | captured from a real run of the framework while this documentation was written (or asserted by a test that runs in the framework's own suite) |
| **Expected output** | derived from the code or a contract and not captured here; the shape is right, the values (ids, timestamps, ports) will differ |
| **Illustrative** | shows the form of something (a diagram, a schema) and is not a transcript |

Ids, timestamps and ports in any transcript are specific to that run.

## A path through the portal

The home page groups the learning path by task. Start with the workspace and one endpoint; use the reference when you need the exact meaning of a command or decorator.

![PSO Web portal home page showing the Get Started, architecture, CLI reference and AI context entry points](@/assets/screenshots/portal-home.png)

*Portal home page, captured from the current documentation renderer. The buttons lead to different kinds of guidance; the steps below are the recommended first route.*

1. [Quick start](/getting-started/quick-start): the whole flow in fifteen commands.
2. [Path Structure Working](/concepts/path-structure-working) for the model, then [Routing](/orchestrator/routes) for the rule that matters most: **an endpoint exists only if it is declared in `ROUTES.pso.ts`.**
3. [Your first application](/tutorials/first-application) and [Build a CRUD API](/tutorials/crud-api).
4. [Security](/security/authentication), [Dispatch](/dispatch/overview) and [Operations](/devops/development-environment) as you need them.
5. [Choosing an approach](/reference/choosing-an-approach) and the [decision guides](/decisions/http-or-dispatch) when two options both seem reasonable.

## Common mistakes when starting

- Reading the portal in order instead of building something: do the [quick start](/getting-started/quick-start) first.
- Expecting PSO to hide Spring or Node: it adds conventions and checks around them.
- Assuming a feature exists because a page mentions the idea: pages state plainly what is not implemented.
