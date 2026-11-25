---
title: Event contracts and versioning
description: The canonical envelope, the closed schema subset, compatibility policies and the contract lock file.
order: 2
status: implemented
keywords: [envelope, event contract, schema, compatibility, versioning, lock file, pso.dispatch.lock.json]
related: [dispatch/overview, dispatch/events-and-consumers, dispatch/reliability]
---
## The envelope

Every event on every provider is the same UTF-8 JSON document, serialized canonically (fixed field order, payload keys sorted). The TypeScript and Java implementations are tested against shared contract data and produce identical bytes.

| Field | Meaning |
|---|---|
| `envelopeVersion` | Version of the envelope itself (`1`) |
| `id` | Unique event id. It is the idempotency key |
| `type` | Event name, a dotted lower-case name such as `users.created` |
| `version` | Schema version of the payload |
| `source` | The publishing service |
| `occurredAt` | UTC timestamp |
| `correlationId` | Carried across services; generated when absent |
| `causationId` | Optional: the event that caused this one |
| `trace` | Optional trace context field. It is carried, not exported (no OpenTelemetry integration) |
| `contentType` | `application/json` |
| `payload` | The event data |

Unknown fields are rejected. Limits: 1 MiB per envelope (configurable down with `pso.dispatch.max-message-size`), 256 characters per metadata value, nesting depth 32. A message that violates them is treated as poison on consume ([Reliability](/dispatch/reliability)). No arbitrary deserialization happens: payloads are parsed as plain JSON data.

## Schemas

Payload schemas use a **closed JSON-Schema subset** with identical semantics in both languages: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, plus `title` and `description`. Anything outside the subset is a validation error at `pso dispatch:validate`, not a silently ignored keyword. Publishing validates the payload; consuming validates it again before the handler runs.

## Compatibility

Each event declares `compatibility`: `backward`, `forward`, `full` (default) or `none`. When you add a new `version` of an event, `pso dispatch:validate` checks the new schema against the highest lower version recorded in the lock file. `none` is the explicit, reviewable way to declare a deliberate breaking change. A consumer lists versions it still understands with `accepts: [1]`; an event with any other version is dead-lettered as `PSO_DISPATCH_UNSUPPORTED_VERSION`.

## The lock file

`pso dispatch:lock` writes `pso.dispatch.lock.json` with the schema of every declared event version. Afterwards the same name and version can never change its schema (`pso dispatch:validate` fails); change means a new version. The file is meant to be committed.

```bash
pso dispatch:validate    # declarations, schemas, lock, compatibility (exit 1 on errors)
pso dispatch:lock        # record the current contracts
```

## What locking does

`pso dispatch:lock` records each event's channel, schema and a hash in `pso.dispatch.lock.json`. Expected output:

```text evidence="expected"
$ pso dispatch:lock
locked: orders.placed@1
```

```json
{
  "comment": "Locked event contracts. Managed by `pso dispatch:lock`; commit it.",
  "contracts": {
    "orders.placed": {
      "1": { "channel": "orders.events", "hash": "6fa7cff47ed3e8cd", "schema": { "type": "object", "required": ["orderId"], ... } }
    }
  }
}
```

Until it exists, `pso dispatch:validate` reports `INFO PSO_DISPATCH_UNLOCKED ... orders.placed v1 is not locked yet` (an informational finding, not an error). After locking, changing the schema of `orders.placed` version 1 is rejected: publish version 2 and state the compatibility.

## Variations

| Change | What to do |
|---|---|
| add an optional field | new version with compatibility declared; lock again |
| rename or remove a field | a new major event version; keep consuming the old one until producers move |
| a deliberate incompatible change | `compatibility: none` as the explicit escape hatch, reviewed |

## Common mistakes

- Editing a schema under the same name and version.
- Not committing the lock file.
- Treating the schema as the only guard: consumers should still be tolerant.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `PSO_DISPATCH_SCHEMA_CHANGED` | a schema changed after `pso dispatch:lock` while still declared as the same version | `git diff` of the schema | declare `version: 2`, then `pso dispatch:lock` |
| `PSO_DISPATCH_004` | the `schema` path in `EVENTS.pso.ts` does not exist | the path in the error | correct it (it also trips the lock check, so two errors appear) |
| `PSO_DISPATCH_UNLOCKED` (`INFO`) | a new event version has no recorded contract | `pso dispatch:validate` | run `pso dispatch:lock` and commit `pso.dispatch.lock.json` |

All three were reproduced; the output is in [Checking Dispatch and what its errors mean](/dispatch/diagnostics).

## Next steps

- [Events and consumers](/dispatch/events-and-consumers)
- [Walkthrough](/dispatch/walkthrough)
