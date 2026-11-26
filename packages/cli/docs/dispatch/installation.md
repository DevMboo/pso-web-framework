---
title: Installing and removing dispatch
description: pso dispatch:install, dispatch:outbox and dispatch:remove, what they change and what they never touch.
order: 5
status: implemented
keywords: [dispatch:install, dispatch:remove, dispatch:outbox, dry-run, idempotent, enable]
related: [dispatch/overview, dispatch/providers, dispatch/outbox, decisions/why-dispatch-optional]
---
Dispatch is installed per service, on request. Generated projects never include a broker adapter.

```bash
pso dispatch:install redis --service users-service   # or rabbitmq | kafka
pso dispatch:inspect                                  # what is declared (no broker is contacted)
pso dispatch:doctor                                   # connects to the configured broker and reports honestly
```

## What `dispatch:install` changes

| Service type | Changes |
|---|---|
| Spring Boot | adds `pso-dispatch-<provider>-starter` to `pom.xml`, sets `pso.dispatch.provider`, adds the provider block with environment references, creates an empty `dispatch/<service>.events.json` |
| Orchestrator | adds `@pso/dispatch` and the client library (`ioredis`, `amqplib` or `kafkajs`) to `package.json`, writes `dispatch.*` in `pso.config.json`, creates `src/dispatch/` |
| Workspace | `infra/dispatch/<provider>.compose.yml`, a local development broker that PSO does not start |

`enabled` stays `false`. Activation is a separate, explicit step: set `pso.dispatch.enabled=true` and the broker environment variable (`REDIS_URL`, `RABBITMQ_URL` or `KAFKA_BOOTSTRAP_SERVERS`). The commands are idempotent, support `--dry-run` and `--json`, never overwrite your declarations, handlers or unrelated configuration, and one service holds one provider (installing a second fails and names `dispatch:remove`).

## Enabling

When `enabled=true` the service validates everything before it listens: provider selected, adapter present, events declared, broker reachable. Any problem stops start-up with a message that names the fix and never contains a broker URL or credential.

## Removing

`pso dispatch:remove --service <name>` removes the adapter dependency and the provider block and sets `enabled: false`, `provider: none`. Event declarations and handlers are kept and stay valid but inactive.

## Optional outbox

`pso dispatch:outbox --service <name>` (Spring services with PostgreSQL and an installed provider) adds the `pso_outbox` Flyway migration once and sets `pso.dispatch.outbox.enabled=true`. See [Outbox](/dispatch/outbox).

## Command overview

| Command | Purpose |
|---|---|
| `dispatch:providers` | capabilities of each provider and where it is installed |
| `dispatch:install` / `dispatch:remove` / `dispatch:outbox` | change a service |
| `dispatch:inspect` | declared setup per service, secrets redacted |
| `dispatch:validate` | static checks of declarations, schemas, lock file, provider consistency |
| `dispatch:lock` | write `pso.dispatch.lock.json` |
| `dispatch:events` / `dispatch:consumers` | what is declared and who consumes it |
| `dispatch:graph` | topology (`--mermaid`) |
| `dispatch:doctor` | connect to the configured broker (the only command that does) |

All accept `--json`. Discovery is structural: `EVENTS.pso.ts` and `*.events.json` are read as data and your code is never executed.

## What the commands print

Expected output of installing Redis into an orchestrator (the install leaves dispatch **disabled**):

```text evidence="expected"
$ pso dispatch:install redis --service gw
package.json: + @pso/dispatch
package.json: + ioredis
pso.config.json: dispatch.provider = redis (enabled stays false; secrets are ${env:...} references)
src/dispatch/: modules go here, each with an EVENTS.pso.ts
infra/dispatch/redis.compose.yml: a local development broker (not started by PSO)
Next: declare your events, then set pso.dispatch.enabled=true (and the broker URL) to activate. See /docs/dispatch/overview.

$ pso dispatch:inspect --service gw
gw (node)  provider: redis  adapter: redis  disabled
  events:    orders.placed@1 -> orders.events
  consumers: -

Declared configuration only: use `pso dispatch:doctor` to test the broker connection.

$ pso dispatch:remove --service gw --dry-run
[dry-run] package.json: - ioredis (@pso/dispatch stays: declarations still use it)
[dry-run] pso.config.json: dispatch disabled, provider none
[dry-run] kept: 1 event declaration(s) and 0 consumer(s) (they stay valid and are inactive)
```

## Is the broker reachable? `dispatch:doctor`

The only command that connects (expected):

```text evidence="expected"
$ pso dispatch:doctor --service gw        # URL set, Redis running
static validation: no findings
UP             gw (redis): PING answered [44 ms]            (exit 0)

$ pso dispatch:doctor --service gw        # URL points at a port nobody listens on
static validation: no findings
DOWN           gw (redis): cannot connect to Redis (Error)  (exit 1)

$ pso dispatch:doctor --service gw        # no broker URL in the environment
static validation: no findings
NOT-CONFIGURED gw (redis): no URL resolves from the environment (REDIS_URL is not set)  (exit 0)
```

`UP` proves the connection and the adapter's own probe; it does not prove events flow. `NOT-CONFIGURED` exits 0 on purpose (nothing is wrong yet); `DOWN` exits 1, so it can gate a deployment.

## Variations

| You want | Do |
|---|---|
| to try it locally | `docker compose -f infra/dispatch/redis.compose.yml up -d`, export the URL, set `enabled: true` |
| to switch provider | `pso dispatch:remove` then `pso dispatch:install <other>` ([migration](/dispatch/providers)) |
| to undo it | `pso dispatch:remove`: declarations and handlers are never deleted |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| publishing says dispatch is disabled | set `enabled` and install a provider (`PSO_DISPATCH_DISABLED`) |
| `DOWN ... cannot connect` | URL, network, credentials (they are redacted in output); is the container running? |
| `install` says another provider is installed | a service uses one provider: `dispatch:remove` first |

## Next steps

- [Walkthrough](/dispatch/walkthrough)
- [Contracts](/dispatch/contracts)
