---
title: Runtime lifecycle
description: Resource states and start/stop ordering in PSO Core and pso dev - what happens when a service fails to start, how rollback works, and and what the orchestrator does on shutdown.
order: 7
keywords: [lifecycle, states, rollback, start, stop, graceful shutdown, SIGTERM]
related: [devops/development-environment, getting-started/running, orchestrator/bootstrap, concepts/structural-discovery]
---
PSO Core has a lifecycle manager used by `pso dev` and available to extensions.

`DISCOVERED -> VALIDATED -> REGISTERED -> INITIALIZED -> READY -> STOPPING -> STOPPED`, plus `FAILED`.

- Resources start **dependency-first** and stop in **reverse** order.
- If one resource fails, everything already started is stopped again (newest first) and dependents are marked `FAILED`; a dependent never becomes `READY` while a dependency is not.
- A failure in one `stop()` never prevents the others from stopping.
- `FAILED` can be retried: the only allowed recovery transition is back to `REGISTERED`.
- Illegal transitions throw, naming the states involved.

## An example with three services

Workspace: `catalog` (no dependencies), `billing` (depends on `catalog`), `gateway` (depends on `catalog` and `billing`).

```flow title="Start and stop order of the three services"
[start order] catalog -> billing -> gateway
[stop order] gateway -> billing -> catalog
```
*(illustrative for three services; for a two-service workspace `pso services:graph` printed `startup order: catalog -> gateway`)*

If `billing` never becomes healthy:

1. `catalog` is already `READY`.
2. `billing` times out: it becomes `FAILED`.
3. `gateway` is never started (its dependency is not ready).
4. The manager stops what was started, `catalog`, and `pso dev` exits with a message naming `billing`. No orphan processes remain; the process trees of failed services are killed too.

In `pso dev` each service is a resource: init checks the path and the port, start spawns the process and waits for its health endpoint, stop terminates the process tree.

## The orchestrator process

The orchestrator itself follows a simpler lifecycle: validate, activate, listen, then shut down on `SIGINT` / `SIGTERM`. Start-up owns everything it acquires (security key providers, Dispatch consumers, the rate-limit connection, Channels, the telemetry exporter, the listener). The listener is bound last, and readiness is reported only after that. If any step fails, including the bind itself (`PSO_HTTP_LISTEN`, for example a port already in use), what was already acquired is released newest first, each release bounded in time, and the log line `start-up failed: acquired resources were released` lists it; a failed start never leaves a consumer, a connection or a listener behind. The generated `main.ts` installs the handlers and sets a 10-second safety timer: if shutdown has not finished by then the process exits with code 1.

`app.close()`, read from the implementation, does these steps in order:

1. marks the telemetry as shutting down (from here `/health/ready` answers 503) and logs `shutdown started` with the number of requests in flight;
2. **stops accepting connections and waits for the requests that are already running**, for at most the grace period (`http.shutdown.graceMs` / `PSO_SHUTDOWN_GRACE_MS`, default 5 seconds). Idle kept-alive connections are closed at once and responses written meanwhile carry `connection: close`. Everything a request needs (security, rate limiting, upstreams, Dispatch publishing) is still available. The log says `in-flight requests finished`, or `the shutdown grace period ended with requests still running` with how many were interrupted;
3. stops the readiness probes, closes Channels (clients are told the server is going away; bounded by `channels.shutdownGraceMs`), then stops the Dispatch runtime (consumers finish or give back their message, then the adapter closes), if enabled;
4. closes the rate limiter (and its Redis connection, if any) and the security key providers, then flushes and stops the OpenTelemetry export, if enabled;
5. closes whatever connection is still open, and the listener.

Each resource is released exactly once and each release is bounded (15 seconds; a timeout is logged as `resource release timed out; continuing` and the next resource is still released). Calling `close()` again returns the same result. Shutdown does not depend on the broker being reachable: stopping Dispatch during a Redis outage returns in about a second.

In the log:

```text evidence="expected"
INFO  [startup] starting orchestrator ...
INFO  [http] orchestrator listening  host=127.0.0.1 port=3000 ...
INFO  shutting down  sig=SIGTERM
INFO  shutdown started  inFlight=0
```
*(expected output; the last two are the messages `main.ts` and `close()` write, not captured here)*

> [!WARNING]
> A request that is still running when the grace period ends is cut and its client sees a connection error; so is every request when the grace period is `0`. Long-lived responses (streams, large downloads) outlive any reasonable grace period. Make clients retry idempotent calls. The generated `main.ts` (`shutdownOnSignals(app)`) ends the process with exit code 1 only when shutdown has not finished after `http.shutdown.graceMs` + `http.shutdown.cleanupMs` + 1 second (5 + 10 + 1 = 16 s with the defaults; both are settings, the deadline is logged as `deadlineMs` when shutdown starts). Whatever stops the process must wait at least that long before it kills it: the generated `docker-compose.yml` sets `stop_grace_period` (default 30 s, `PSO_STOP_GRACE_PERIOD`), on Kubernetes that is `terminationGracePeriodSeconds`. A second signal during shutdown is ignored. On Windows, where `SIGTERM` does not exist, Ctrl+C (`SIGINT`), `SIGBREAK` and the IPC message `"shutdown"` do the same. A `main.ts` generated before this version still contains a fixed `setTimeout(() => process.exit(1), 10_000)`, which cuts a grace period above about 10 s short. `pso migrate` shows the change and `pso migrate --apply` makes it: it replaces the generated block and the import, leaves the rest of the file as it is and keeps the previous file as `main.ts.bak`. Signal handling you edited yourself is not rewritten; the command reports it and says what to change. Spring services use `server.shutdown: graceful`.

## What this means for you

| Situation | Effect |
|---|---|
| a container is stopped (`SIGTERM`) | no new connections; running requests get the grace period to finish; background work is stopped; the process exits 0 |
| shutdown takes longer than grace period + cleanup time + 1 s (16 s by default) | the process exits with code 1 |
| a second `SIGTERM`/`SIGINT` arrives during shutdown | ignored: one shutdown runs, with the same deadline |
| a Spring service | uses Spring's `server.shutdown: graceful` (set in the generated configuration) |
| you add startup work to a provider constructor | it delays readiness; keep constructors fast |

## Application hooks

Between "the listener is bound" and "the application reports ready", the orchestrator calls `onReady` on the lifecycle hooks the modules declare; during shutdown, after the running requests finished and before its own resources are released, it calls their `onShutdown` in reverse order. A hook is a provider listed in a `MODULE.pso.ts` (`pso make:hook <name> --module <module>`), never a file found in a folder; a failing `onReady` stops start-up like any other start-up failure. Details: [services and providers](/orchestrator/services-and-providers).

## Common mistakes

- Killing the process with `SIGKILL` as a routine: background work (rate-limit connection, Dispatch consumers, telemetry export) is not stopped cleanly.
- Doing slow I/O in constructors (it blocks readiness and hides in the start-up time).
- Assuming `pso dev` restarts a crashed service: it probes each ready service every 5 seconds and reports `[pso] <name> is now DOWN`/`UP`; a failed start aborts and rolls back.
- Assuming the orchestrator drains in-flight requests on `SIGTERM` (see the warning above).

## Next steps

- [Development environment](/devops/development-environment)
- [Bootstrap](/orchestrator/bootstrap)
