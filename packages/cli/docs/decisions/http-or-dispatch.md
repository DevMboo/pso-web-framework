---
title: HTTP call or Dispatch event?
description: When one service should call another and wait, and when it should publish an event and move on - the consequences for coupling, failure, consistency and testing.
order: 32
keywords: [decision, http, dispatch, events, synchronous, asynchronous, coupling, at-least-once]
related: [dispatch/overview, dispatch/reliability, orchestrator/upstream-clients, spring/http-client, decisions/sync-or-async, decisions/outbox-or-direct-publish]
---
## The question

Service A needs something to happen in service B. Does A call B over HTTP, or publish an event that B consumes?

## The short answer

| Use an HTTP call when | Use a Dispatch event when |
|---|---|
| A needs B's **answer** to continue (a price, a permission, a lookup) | A only needs to **announce** that something happened |
| the user is waiting and expects the result in the same response | the work can finish after the response, or never needs to reach A again |
| one specific callee | zero, one or many interested consumers, unknown to A |
| failure must fail the request immediately | failure must not stop A; B catches up later |

## What changes when you choose events

| | HTTP | Dispatch |
|---|---|---|
| Coupling | A knows B's address and API | A knows an event name and contract; B is invisible |
| Availability | A fails if B is down | A works if B is down; B processes when back |
| Delivery | request/response, you see the failure | **at-least-once**: delivered once or more, so handlers must be idempotent |
| Consistency | immediate | eventual |
| Ordering | trivially in call order | only per key within a partition/queue ([providers](/dispatch/providers)) |
| Debugging | one call chain, one correlation id | a trail across a broker; the envelope has `correlationId`, `causationId` and `trace` fields, but a handler's own publish does not copy them automatically (see the [walkthrough](/dispatch/walkthrough)) |
| Testing | start B or fake it | a broker (or a local container) is required for real tests |
| Cost of getting it wrong | a timeout | duplicates, a stuck partition during retries, dead letters to review |

## Decision flow

1. **Do you need the result now?** HTTP.
2. **Could B be slow or down without A caring?** Event.
3. **Is it a fact ("order placed") rather than a command ("charge the card")?** Facts fit events; commands with a required outcome fit HTTP.
4. **Will more than one party care, now or later?** Event; adding a consumer needs no change in A.
5. **Do you need atomicity with A's database write?** Use an event **through the outbox**, not a direct publish ([outbox or direct publish](/decisions/outbox-or-direct-publish)).

## Worked example

Placing an order. The gateway needs the created order back (HTTP to `orders`). `orders` then announces `orders.created`; `billing` and `notifications` consume it independently. Billing being down delays invoices, not orders. The order is stored and the event is written in the same transaction (outbox); the consumers deduplicate on the event id.

```text evidence="illustrative"
client -> gateway --HTTP--> orders --(db tx: order + outbox row)--> relay --> broker --> billing, notifications
```

## Anti-patterns

- Using events to fake a synchronous call (publish, then poll for the answer). If you need the answer, call.
- Publishing commands that must succeed ("send the invoice") and assuming they did. At-least-once means "might repeat", not "will certainly happen".
- Chaining many HTTP calls so a user request depends on five services all being up. Aggregate in the orchestrator carefully, with timeouts, or move some steps to events.
- Dispatch for everything "to be modern". It is optional on purpose: a new project has it disabled ([why](/decisions/why-dispatch-optional)).

## When the answer changes

Start with HTTP; introduce events when a second consumer appears or when A's availability must not depend on B. Moving later is a planned change (declare the event, add the consumer, then remove the call), not a rewrite.

## Related

[Dispatch overview](/dispatch/overview) · [Reliability](/dispatch/reliability) · [Upstream clients](/orchestrator/upstream-clients) · [Sync or async](/decisions/sync-or-async)
