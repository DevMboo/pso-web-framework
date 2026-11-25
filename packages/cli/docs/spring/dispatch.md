---
title: Dispatch configuration
description: The pso.dispatch.* settings, the provider starters and the Spring Boot API for events.
order: 9
status: implemented
keywords: [dispatch, pso.dispatch, redis, rabbitmq, kafka, outbox, idempotency, pso-dispatch-api, PsoEventHandler]
related: [dispatch/overview, dispatch/reliability, dispatch/outbox, spring/configuration]
---
Every generated service carries the dispatch settings, **disabled**:

```yaml
pso:
  dispatch:
    enabled: false
    provider: none
```

With these defaults no broker is contacted, no consumer starts, no topic is created and `PsoDispatch` is a `Disabled` bean that fails clearly if used. Activate with `pso dispatch:install <redis|rabbitmq|kafka>` and `enabled: true` ([Installation](/dispatch/installation)).

## Settings

| Property | Default | Meaning |
|---|---|---|
| `pso.dispatch.enabled` | `false` | master switch |
| `pso.dispatch.provider` | `none` | `redis`, `rabbitmq` or `kafka`; must match the installed starter |
| `pso.dispatch.max-message-size` | `1MB` | upper bound for one envelope |
| `consumer.concurrency` / `consumer.batch-size` | `1` / `10` | parallel handlers and read batch |
| `retry.enabled`, `max-attempts`, `initial-delay`, `max-delay`, `multiplier` | `true`, `3`, `1s`, `30s`, `2.0` | in-process retry with backoff |
| `dead-letter.enabled` | `true` | exhausted and poison messages go to `<channel>.dlq` |
| `idempotency.retention` | `24h` | how long processed ids are remembered |
| `outbox.enabled` and `outbox.*` | `false` | [transactional outbox](/dispatch/outbox) |
| `redis.*`, `rabbitmq.*`, `kafka.*` | environment references | the provider block written by the installer |

## Start-up validation

`enabled=true` without a provider, without the matching starter on the classpath, with a different installed provider, or with no declared events stops the service with a message naming the fix (for example `pso dispatch:install redis`). Invalid declarations list every problem and start nothing. In production (the `prod` / `production` profile, or `PSO_ENV=production`) `pso.dispatch.trust.mode=off` also stops the service unless `pso.dispatch.allow-unauthenticated=true` declares the legacy mode ([publisher authentication](/dispatch/security-and-observability)).

With `enabled=false` (the generated default) nothing connects. `PsoDispatch` and, for code that injects it, `Outbox` are placeholders: the service starts, and publishing or storing an event fails with `PSO_DISPATCH_DISABLED`, so a transaction that tried to store an event rolls back instead of losing it. With dispatch enabled there is no placeholder outbox: code that needs `Outbox` while `pso.dispatch.outbox.enabled` is false fails at start-up.

## API

`pso-dispatch-api` provides `PsoDispatch` (publish, health, metrics), `@PsoEventHandler`, `ConsumeContext` and the shared envelope and schema validator; it has no broker client on its classpath. Events are declared in `src/main/resources/dispatch/*.events.json` ([Declaring events](/dispatch/events-and-consumers)). The delivery guarantee is at-least-once; exactly-once is not claimed ([Reliability](/dispatch/reliability)).

## What a Spring consumer does at run time

The same envelope, retry, dead-letter and acknowledgement rules as the TypeScript runtime (the verified transcript is the [walkthrough](/dispatch/walkthrough), which uses a TypeScript consumer for speed). The Spring side adds the transactional outbox ([outbox](/dispatch/outbox)) and publishes the same counters as Micrometer meters.

## The tests of a service with Dispatch enabled

`pso dispatch:install` also prepares the service's own tests: it adds `com.pso:pso-dispatch-test` with **test scope** and sets, in `application-test.yml`:

```yaml title="src/main/resources/application-test.yml (added)"
pso:
  dispatch:
    provider: memory   # tests publish and consume in process (com.pso:pso-dispatch-test): no broker is needed
```

So when you switch Dispatch on the documented way (`pso.dispatch.enabled: true` in `application.yml`), every `@SpringBootTest` that uses the `test` profile (the generated tests do) still starts, publishes and runs its `@PsoEventHandler` methods without Redis, RabbitMQ or Kafka. A test can inject `MemoryAdapter` to look at what was published.

| Rule | Detail |
|---|---|
| Test only | the adapter exists only where `pso-dispatch-test` is on the classpath; the dependency has test scope, so it is not in the application artifact |
| Never in production | `pso.dispatch.provider=memory` with a production profile stops start-up; `pso security:validate` reports it outside `application-test.yml` (`SPR015`) |
| Not a broker | it proves nothing about delivery, ordering, redelivery after a crash or durability |
| Real broker tests | an integration test that must use the broker selects it itself: `@SpringBootTest(properties = "pso.dispatch.provider=redis")`, with the broker URL from the environment |

The Dispatch classes of a layered service live in `application/event/` (`events/` in the 0.1 layout); a test of them uses the same package.

```java title="src/test/java/com/pso/orders/application/event/OrdersPlacedBrokerTests.java (an integration test against the real broker)"
package com.pso.orders.application.event;

import com.pso.dispatch.PsoDispatch;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(properties = {"pso.dispatch.enabled=true", "pso.dispatch.provider=redis"})
@ActiveProfiles("test")
class OrdersPlacedBrokerTests {

    @Autowired PsoDispatch dispatch;

    @Test
    void publishesThroughRedis() {
        dispatch.publish("orders.placed", new OrdersPlacedEvent("o-1", "c-1", 12.5));
    }
}
```

## Common mistakes

- A handler that mixes a database write and a broker publish without the outbox ([decision](/decisions/outbox-or-direct-publish)).
- Declaring the event in YAML but forgetting to install a provider starter.
- Treating `@PsoEventHandler` methods as request handlers: they run on consumer threads, without a request context or an authenticated user.

## Next steps

- [Walkthrough](/dispatch/walkthrough)
- [Outbox](/dispatch/outbox)
