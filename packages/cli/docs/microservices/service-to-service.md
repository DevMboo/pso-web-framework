---
title: Service-to-service communication
description: What PSO provides for calls between services - the gateway path, the Spring HTTP client with TLS and mTLS, events - and what you decide yourself, with the safety rules each path enforces.
order: 9
status: partial
keywords: [service to service, communication, mtls, token propagation, PsoHttpClient, dispatch, upstream]
related: [orchestrator/upstream-clients, security/service-identity, spring/http-client, decisions/http-or-dispatch]
---
There are three ways for work to cross a service boundary. They have different guarantees; choosing among them is a design decision ([HTTP or Dispatch?](/decisions/http-or-dispatch)).

| Path | Direction | Use for | Guarantees |
|---|---|---|---|
| **Gateway forward** | client to orchestrator to service | requests that start at a user | route policy, JWT checked at the gateway and again in the service, rate limits, correlation id |
| **Spring `PsoHttpClient`** | service to service, synchronous | a service needs another service's answer | declared destinations only, strict URL rules, no redirects, optional TLS/mTLS, bounded retries, correlation propagation |
| **Dispatch events** | service to any number of services, asynchronous | announcing facts | at-least-once delivery, retries, dead letters, optional transactional outbox ([Dispatch](/dispatch/overview)) |

:::diagram name="distributed"

## 1. Through the orchestrator

The orchestrator forwards a request with a verified bearer token (only on guarded routes, and only under the upstream's policy); the service validates it again. This is the default path for anything that originates from a user request, because route policy and token validation apply. [Upstream clients](/orchestrator/upstream-clients) explains the forwarding rules, including what is stripped (`x-pso-*`, `x-forwarded-for`, a client-supplied `x-correlation-id`).

## 2. Direct calls from a Spring service

Use `PsoHttpClient` (starter `pso-http-spring-boot-starter`):

```java
return http.get("customers", "/customers/{id}", CustomerDto.class, id);
```

The first argument must be a service declared under `pso.http.client.services`; anything else is refused before any network I/O. Redirects are never followed; plain `http` to a non-loopback host is refused unless explicitly allowed; the caller's bearer token is forwarded only to services configured with `forward-bearer: true`, and only when the audience matches. Full reference: [Spring HTTP client](/spring/http-client).

For back-channel calls that are not on behalf of a user, give the caller its **own** credentials (a service identity: a client certificate with mTLS, or its own token with a dedicated audience and scopes) and let the callee validate it like any other. Do not rely on network location for trust ([service identity](/security/service-identity)).

## 3. Events

When the caller does not need an answer, publish an event. The consumer is invisible to the publisher, and the broker absorbs downtime. The cost is at-least-once delivery: consumers must be idempotent.

## Making the dependency visible

A call between services is a dependency; record it:

- `pso services:register ... --depends-on` (or `dependsOn` in `pso.workspace.json`) records start-up order.
- Describe the operation in a [service contract](/microservices/service-contracts).
- Declare event types with their producers and consumers ([event declarations](/dispatch/contracts)); `pso dispatch:graph` shows the topology.

## What is not provided

- A generated client for another service's API (you write the DTOs and call `PsoHttpClient`).
- A circuit breaker. The client has timeouts and bounded retries (idempotent methods only by default), not a breaker.
- A service mesh. TLS and mTLS between services are available as configuration; certificate issuance and distribution are yours.

## Common mistakes

- Calling a service by a hard-coded URL instead of a declared one.
- Forwarding the user's token everywhere. Forward only where the callee should act as the user, and bind it to an audience.
- Chaining many synchronous calls in a request path: availability multiplies down.
- Using events for something that needs an answer.

## Next steps

- [Spring HTTP client](/spring/http-client)
- [Service identity and mTLS](/security/service-identity)
- [Event dispatch](/dispatch/overview)
