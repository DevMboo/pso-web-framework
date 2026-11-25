---
title: Synchronous or asynchronous operations?
description: Whether an operation should finish before the response is sent, and how to model the work that cannot - without pretending that PSO has a job queue it does not have.
order: 36
keywords: [decision, synchronous, asynchronous, latency, timeout, events, long running, 202]
related: [decisions/http-or-dispatch, decisions/outbox-or-direct-publish, orchestrator/upstream-clients, dispatch/reliability]
---
## The question

A request triggers work. Does the client wait for it, or do you answer now and finish later?

## The short answer

| Do it synchronously when | Do it asynchronously when |
|---|---|
| it is fast (milliseconds to a couple of seconds) and bounded | it can take long, or its duration varies a lot |
| the client needs the result to continue | the client only needs to know it was accepted |
| failure should be visible immediately | failure can be handled later (retry, notify) |
| it is a single service's work | it spans services that may be slow or down |

## What PSO gives you

- **Bounded waiting.** Every upstream call has a timeout (`http.limits.upstreamTimeoutMs`, default 5000 ms), and the orchestrator answers `504` if it expires. The request cannot hang forever.
- **Events.** Dispatch moves work between services with retries and dead-lettering. It is at-least-once, in-process retry, no delayed redelivery ([reliability](/dispatch/reliability)).
- **No built-in job API.** PSO does not provide "submit a job, get a job id, poll for status". If you want that shape, you design it: store a job row, publish an event, expose `GET /jobs/{id}`.

## A pattern for work that takes too long

1. `POST /reports` validates the request, stores a row `status = PENDING` and writes an event through the [outbox](/decisions/outbox-or-direct-publish) in one transaction. Answer `202 Accepted` with the id (the controller chooses the status; PSO answers `201` for `POST` by default in the orchestrator, and your Spring controller sets its own with `@ResponseStatus`).
2. A consumer in the owning service does the work and updates the row (`RUNNING`, then `DONE` or `FAILED`).
3. `GET /reports/{id}` returns the status and, when done, a link or the result.
4. The consumer is idempotent, because delivery is at-least-once.

## Consequences

- **User experience.** Async means designing the "not done yet" state: statuses, polling or notifications, what to show.
- **Failure handling.** A synchronous failure is a `5xx` to the caller. An asynchronous failure needs a place to land: a `FAILED` status, a dead-letter channel someone watches.
- **Consistency.** Reads right after a write may not see the effect. Say so in the contract.
- **Observability.** HTTP hops share one correlation id ([logging](/devops/logging)). Across an event, put the originating id in the payload or set the envelope's `correlationId` yourself when you publish: the runtime does not copy it from the event being handled (see the [walkthrough](/dispatch/walkthrough)).

## Anti-patterns

- Raising timeouts until slow work "fits" in a request. It holds a connection and a thread per client.
- Fire-and-forget with no way to learn that it failed.
- Making everything async: each hop adds a failure mode and latency to debug.
- Polling in a tight loop. Use a sensible interval and a status resource.

## Related

[HTTP or Dispatch](/decisions/http-or-dispatch) · [Reliability](/dispatch/reliability) · [Upstream clients](/orchestrator/upstream-clients)
