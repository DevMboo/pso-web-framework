---
title: Task: install event dispatch
description: Steps to add and enable Redis Streams, RabbitMQ or Kafka dispatch to a service.
order: 27
scope: install-dispatch
base: false
requires: [dispatch]
keywords: [ai, task, dispatch, install]
---
Ask which service and which provider (`redis`, `rabbitmq` or `kafka`) if the user did not say. Then:

1. `pso dispatch:install <provider> --service <name> --dry-run`, review, then run it without `--dry-run`. It is idempotent and keeps user code.
2. Declare events: `EVENTS.pso.ts` with `defineEvents` plus `@DispatchConsumer` classes (orchestrator), or `dispatch/<service>.events.json` plus `@PsoEventHandler` methods (Spring). Every event needs `name`, `version`, `channel` and a payload schema.
3. `pso dispatch:validate`, then `pso dispatch:lock`.
4. Tell the user to set the broker environment variable (`REDIS_URL`, `RABBITMQ_URL` or `KAFKA_BOOTSTRAP_SERVERS`) and `enabled: true` themselves; never write credentials into files and never ask for them in chat.
5. `pso dispatch:doctor` to test the connection. If no broker is available, say the integration is unverified instead of claiming it works.
6. For atomic "save and publish" in a Spring service with PostgreSQL: `pso dispatch:outbox --service <name>`.

State the guarantee plainly: **at-least-once**, handlers must be idempotent. Do not claim exactly-once.
