---
title: Dispatch security and observability
description: Transport security, secret handling, what is logged, metrics and health, and what observability is not implemented.
order: 8
status: partial
keywords: [tls, sasl, secrets, observability, metrics, health, logging, correlation id]
related: [dispatch/providers, dispatch/reliability, dispatch/visualization]
---
## Security

- **Secrets never live in files the CLI writes.** Broker URLs and credentials are environment references (`${env:RABBITMQ_URL}` / `${RABBITMQ_URL:}`). `dispatch:inspect`, Studio and the AI context redact them; `dispatch:doctor` masks credentials in any error it prints.
- **Errors are sanitized.** Connection failures report the error class and the fix, not the URL. Log lines carry event type, id, attempt and error class, never payloads or metadata values.
- **Transport:** use `rediss://`, `amqps://` or Kafka `ssl` for anything that leaves your machine. Kafka SASL is refused over plaintext. Authentication is whatever the broker supports through the URL or the SASL block; PSO adds no custom crypto.
- **No arbitrary deserialization.** Payloads are parsed as JSON data and validated against the declared schema; classes are never instantiated from message content. Java handlers bind the validated JSON to the handler parameter type with Jackson.
- **Size and shape limits** (1 MiB, depth 32, metadata length) are enforced before a handler runs.

Authorization of who may publish or consume a channel is a broker concern (ACLs, vhost permissions, Redis ACL users). PSO does not model it.

### Publisher authentication

The envelope's `source` is a field the producer writes: on its own it proves nothing. A service with a signing key adds a transport header to every event it publishes (the envelope format does not change, so a consumer that does not verify ignores it):

```text evidence="illustrative"
x-pso-signature: v1=base64url( HMAC-SHA256( key, channel + "\n" + the exact envelope bytes ) )
```

A consumer looks the key up by the source the envelope claims, so a service holding only its own key cannot sign as another one, and neither the content nor the channel can change without invalidating the signature. Both runtimes produce identical signatures (checked against shared contract data).

| Setting | Node | Spring |
|---|---|---|
| this service's key (32+ characters, environment only) | `PSO_DISPATCH_SIGNING_KEY` | `pso.dispatch.signing-key` (the same variable binds to it) |
| a publisher's key on the consumer | `PSO_DISPATCH_TRUST_KEY_<SERVICE>` | the same variables, or `pso.dispatch.trust.keys.<service>` |
| mode | `dispatch.trust.mode` | `pso.dispatch.trust.mode` |

| Mode | Unsigned event | Wrong signature | Valid signature |
|---|---|---|---|
| `off` (default) | handled | handled (not checked) | handled |
| `permissive` | handled and counted (`unverified`) | dead-lettered | handled, `verifiedSource` set |
| `required` | dead-lettered | dead-lettered | handled, `verifiedSource` set |

A refused event is never handled or retried; it goes to `<channel>.dlq` with the reason `PSO_DISPATCH_UNTRUSTED:unsigned`, `:unknown-source` or `:invalid`. Handlers read the authenticated publisher from `ctx.verifiedSource` (Java: `ctx.verifiedSource()`); use it, not `envelope.source`, for authorization. To migrate: give every publisher its key, run consumers in `permissive` until `unverified` stays at zero, then switch to `required`. Several comma separated keys per service allow rotation.

#### Production policy and privileged consumers

Trust mode `off` is a development default, not a production one. With `PSO_ENV=production` (or `NODE_ENV=production`; Spring: the `prod` / `production` profile, which the generated image sets) a service whose Dispatch is enabled **does not start** with mode `off`: the error names `dispatch.trust.mode` and the keys to set. `required` without any key is refused everywhere.

| You want | Set | Result |
|---|---|---|
| secure production | `dispatch.trust.mode: required`, `PSO_DISPATCH_SIGNING_KEY`, `PSO_DISPATCH_TRUST_KEY_<SERVICE>` | only signed events of known services are handled |
| to migrate without dropping traffic | mode `permissive` with the keys | unsigned events still handled and counted (`unverified`); wrong signatures refused |
| to keep a legacy installation running as it is | `PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true` (exactly `true`) | starts with mode `off`; an `INSECURE legacy mode` warning at every start |

The legacy switch is never equivalent to a verified publisher. A consumer that **acts on who published** an event declares it, and then never runs on a claim in any mode:

```ts title="a privileged consumer (Node)"
@DispatchConsumer("billing.invoice-paid", { requireVerified: true })
export class GrantCredit { handle(payload: InvoicePaid, ctx: ConsumeContext) { /* ctx.verifiedSource is always set here */ } }
```

An unsigned, forged or unknown publisher is dead-lettered for that consumer (`PSO_DISPATCH_UNTRUSTED:...`) while ordinary consumers of the same event keep the behaviour of the mode; a service with such a consumer and no verification key refuses to start (`PSO_DISPATCH_TRUST_KEYS`). In Java call `ctx.requireVerifiedSource()`: it returns the verified publisher or throws, so the message fails instead of being authorized on the envelope's claim. The Channels bridge is such a consumer: see [Channels](/orchestrator/channels).

Limits: keys are symmetric, so a consumer able to verify a service could also sign as it (give each key only to its service and its verifiers). A captured, validly signed event can be replayed by someone who can write to the broker; the idempotency store suppresses replays inside its retention, and broker authentication and ACLs remain the first line of defence. A broker connection being authenticated does not, by itself, authenticate the `source` of a message.

## Observability

Implemented:

- Counters in both runtimes: published, publish failures, consumed, handler failures, retries, dead-lettered, dropped, duplicates, poison, processing count/total/max time.
- `Dispatch.health()` / `PsoDispatch.health()`: the adapter's own probe (`PING`, channel open, metadata request).
- `correlationId` is generated or propagated in the envelope and appears in structured log fields.
- `pso dispatch:doctor` for a live connection test.

In an orchestrator the dispatch counters and broker health are part of the [runtime telemetry](/devops/observability) (diagnostics endpoint and, with an OTLP endpoint, the `pso.dispatch.*` metrics; Spring services publish the same counters plus `pso.outbox.*` as Micrometer meters). **Not implemented:** trace context carried in the event envelope end to end (the envelope only has a `trace` field), consumer lag display in Studio, a `dispatch:health` command, alert rules. Redis exposes lag and pending counts through the adapter (`groupInfo`) for your own diagnostics.

## What the telemetry says (expected)

With `PSO_DIAGNOSTICS_TOKEN` set, `GET /_pso/telemetry` returns the dispatch counters and the adapter's own health. From the walkthrough run:

```json evidence="expected"
{"metrics":{"published":1,"publishFailed":0,"consumed":1,"failed":3,"retried":2,"deadLettered":2,"dropped":0,"duplicates":0,"poison":1,
 "byType":{"orders.placed":{"published":0,"consumed":1,"failed":3},"orders.confirmed":{"published":1,"consumed":0,"failed":0}}},
 "health":{"status":"up","detail":"PING answered"}}
```

and the log says what failed without exposing it: `WARN consumer failed event=orders.placed id=evt-bad-1 attempt=1 error=Error` (the error class, never the message). Broker URLs and credentials do not appear in logs (asserted by tests).

## Common mistakes

- Logging payloads in handlers (they may contain personal data).
- Putting the broker URL with credentials in a file instead of the environment.
- Alerting on the counters only: also watch the `.dlq` channels in the broker.

## Next steps

- [Runtime telemetry](/devops/observability)
- [Walkthrough](/dispatch/walkthrough)
