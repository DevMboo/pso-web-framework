---
title: PSO Studio
description: The local developer control center: what each screen shows, where the data comes from and how it is protected.
order: 7
keywords: [studio, pso studio, dashboard, topology, routes, modules, security, observability, diagnostics, settings]
related: [devops/development-environment, orchestrator/routes, security/security-configuration, dispatch/visualization]
---
```bash
pso studio [--port N] [--no-open] [--remote]
```

Studio is a read-only control center (with `--remote` it also gains the **Cloud** section to manage servers: see [Studio Cloud section](/cloud/studio-cloud)) for the workspace it was started in. Every figure comes from the workspace files, the `pso dev` registry, live health probes or log files. Nothing is simulated: when a source does not exist, the screen says so instead of showing zero.

![PSO Studio overview for a generated workspace before either service has started, showing zero healthy services, one declared route, topology and configuration diagnostics](@/assets/screenshots/studio-overview.png)

*A real Studio capture from a disposable workspace before `pso dev` started. `0/2` healthy means both declared services are stopped; it does not mean the route declaration is missing. The topology shows the gateway-to-catalog route, while Recent activity names missing development JWT settings. Start the services and refresh to compare the live state.*

## Screens

| Screen | Developer question | Data source |
|---|---|---|
| Overview | Is my application running and what needs attention? | live probes, `pso dev` registry, route and module analysis, diagnostics, logs |
| Workspaces | Which workspace is this and what does it declare? | `pso.workspace.json` |
| Services | Which services exist, are they healthy, how are they connected? For Spring services: which starters, prefix, security, HTTP client, database and dispatch settings are in effect, and does the configuration validate? | workspace, live probes, registry, discovered resources, `application*.yml` (read statically, no secret values) |
| Routes | Which endpoints are exposed, who may call them and where do they go? | `ROUTES.pso.ts` registries (static analysis) |
| Modules | How are modules composed and is any declaration broken? | `MODULE.pso.ts` and `ROUTES.pso.ts` (static analysis) |
| Dispatch | Which providers, events, producers and consumers are declared, and (on request) is the broker reachable? | `EVENTS.pso.ts`, `*.events.json`, dispatch configuration (static), opt-in connection probe |
| Security | How is authentication configured and which routes are protected? | `security.*` configuration, route analysis, `security:check` |
| Observability | What did my services log, can I follow one request? | `.pso/logs/*.log` |
| Diagnostics | What is wrong and how do I fix it? | route validation, security checks, security configuration |
| Settings | Where does each setting come from, is it valid per environment? | configuration layers (values masked) |

## Health states

Health is derived from a live probe of the declared health endpoint and the `pso dev` lifecycle. It is never inferred from registration alone.

| State | Meaning |
|---|---|
| Healthy | the health endpoint answered `200` in under one second and the lifecycle is `READY` (or the service was not started by `pso dev`) |
| Degraded | it answers, but the lifecycle is not `READY` or the probe was slow (over 1000 ms) |
| Unhealthy | the endpoint answered with a non-`200` status, or `pso dev` reports the service as started or failed but nothing answers |
| Stopped | nothing answers on the declared port and no running process is registered |
| Unknown | the probe could not be run |

## Routes and modules

Only routes declared in a valid `ROUTES.pso.ts` appear as active; a controller decorator alone never implies exposure. The module graph draws `MODULE.pso.ts` imports only. Runtime communication between services is drawn in the Overview topology, never mixed into the module graph. An unresolved import is drawn to a marked placeholder.

## Observability

The log viewer reads structured JSON lines (and classifies plain text lines by keyword). It supports severity, service, correlation id, free text and time range filters, and shows tables in pages of 50 entries; the server returns at most 1000 entries per request. Time ranges only match lines that carry a timestamp. There are no charts other than counts taken from the real log lines and the latest health probe latency.

Runtime telemetry of the orchestrator (requests, errors, latency, rate limiting and, in the API payload, dispatch counters) is shown on the Observability page when the service exposes its authenticated diagnostics endpoint ([Runtime telemetry](/devops/observability)); every other service is shown as Not instrumented, Not configured, Unavailable or Unknown with the reason, and without numbers. Consumer lag and dead-letter depth are **not available**: the runtime does not export them, and Studio never shows a zero in their place.

## Security of Studio itself

- Binds to `127.0.0.1` only, requires a one-time token (cookie `HttpOnly; SameSite=Strict`) and checks the `Host` header against DNS-rebinding.
- **Read-only:** every method other than `GET` is rejected, and there are no configuration mutation endpoints. If mutation is ever added it must go through authenticated, authorized and audited framework APIs.
- Content security policy `default-src 'self'` with no inline script or style, no framing, no form posts, no remote origins. The interface renders all data as text; log lines containing HTML are shown literally.
- Secrets are masked on the server: bearer tokens, JWTs, private keys and secret-looking keys (`password`, `token`, `apiKey`, `authorization`, ...) never reach the browser, the API or the copied diagnostic context.
- No CORS headers are sent, so other origins cannot read the API.
- Localhost is not treated as harmless: the token, the host check and the read-only rule apply there too. Remote access is not supported; do not expose the port.

## Documentation and AI context

Screens link to the matching documentation (routes, modules, security, dispatch, error codes and command references). The documentation is built on first use and served by Studio under `/docs/` on the same origin. On Diagnostics, **Copy AI context** copies a sanitized summary (workspace counts, routes and diagnostics) for AI-assisted troubleshooting; it never contains tokens, keys or secret values.

## Interface

Dark and light themes (follows the system preference and remembers your choice), collapsible navigation, global search over services, routes, modules and pages (press `/` or `Ctrl+K`), keyboard-accessible tables, graphs and drawers (`Esc` closes a drawer and returns focus), and responsive layouts down to phone width. Views refresh every five seconds only while visible and only where live data matters (Overview, Services, Observability); refresh pauses while you type or a drawer is open, and requests made obsolete by navigation are cancelled.

## Not implemented

Remote access with authentication, configuration editing, lifecycle actions (start, stop, restart), notifications and consumer lag / dead-letter depth (not exported by the runtime).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| the browser shows "access denied" | the URL carries a one-time token: use the URL printed by the current `pso studio` run (a previous token is invalid) |
| a service shows as unavailable | Studio probes real endpoints: start the service (`pso services:health` says the same) |
| the observability screen is empty | it reads `.pso/logs/*.log`, written by `pso dev`; a service started elsewhere has no log there |
| consumer lag or dead-letter depth is missing | they are not exported; Studio shows "unavailable", not zero |

## Common mistakes

- Sharing the Studio URL (it contains the token).
- Exposing the port beyond loopback: remote access is unsupported.
- Reading "healthy" as "correct": it means the health probe answered.

## Next steps

- [Development environment](/devops/development-environment)
- [Runtime telemetry](/devops/observability)
