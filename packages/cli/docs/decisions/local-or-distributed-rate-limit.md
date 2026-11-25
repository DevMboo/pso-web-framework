---
title: Local or distributed rate limiting?
description: When per-instance token buckets are enough and when several instances must share one budget through Redis - including failure policy and client identity behind proxies.
order: 37
keywords: [decision, rate limit, redis, local, distributed, token bucket, failure policy, proxy]
related: [security/rate-limiting, reference/error-standard, security/attack-prevention, decisions/dev-or-production-config]
---
## The question

You run the orchestrator (or a Spring service) in more than one copy. Does each copy count requests on its own, or do they share one budget?

## The short answer

| | Local (default) | Distributed (Redis) |
|---|---|---|
| Counting | in each process | one shared counter set in Redis |
| Effective limit with N instances | up to **N times** the configured limit | the configured limit |
| Dependencies | none | a Redis you operate (`rediss://` in production for a non-local Redis) |
| Cost per request | in-memory | one atomic script round trip |
| If the backend fails | not applicable | your explicit choice: `closed` (default) answers `503 PSO_RATE_LIMIT_UNAVAILABLE`, `open` lets traffic through |
| Best for | development, a single instance, coarse protection | production with several instances, fairness between callers, protecting an expensive endpoint |

## Decision flow

1. **One instance?** Local.
2. **Several instances and the limit is a rough safety net** (600 per minute against a service that can take far more)? Local may be acceptable: N times a generous limit is still a limit.
3. **Several instances and the limit protects something expensive or contractual** (a paid upstream, a per-customer quota)? Distributed.
4. **Behind a load balancer that spreads one client over all instances?** Distributed, otherwise one client gets N budgets.

## What you must decide for distributed

- **Failure policy.** `closed` protects the backend but makes Redis a dependency of every request; `open` keeps serving but loses protection while Redis is down. For an authentication endpoint choose closed; for a read-only public page, open may be right.
- **Client identity.** The limiter keys on the client address. Behind a proxy the TCP peer is the proxy, so every client looks the same. Configure `trustedProxies` so `X-Forwarded-For` is honoured **only** from your proxies; the chain is read from the right, so a client cannot choose its identity. Wrong settings either throttle everyone together or let anyone pick their own key.
- **Per-principal budgets** (`perPrincipal`, default true) stop one noisy caller behind a shared address from exhausting others.
- **Route policies** for the few endpoints that need stricter limits (login, password reset, expensive search).

## Consequences

- Redis becomes part of your request path. Monitor it, and test the failure policy you chose.
- Counters are keyed and bounded (`maxKeys`), so memory is capped; the least recently used keys are evicted.
- The orchestrator and Spring services run the same behavioral contract, so a limit means the same thing on both.

## Anti-patterns

- Raising the local limit by N "to compensate" for N instances: bursts from one client still hit one instance.
- Trusting `X-Forwarded-For` from anywhere.
- Choosing `open` for login endpoints, or `closed` for health checks (health probes are never limited).
- Treating rate limiting as DDoS protection. It is one layer; the edge network and the platform carry the volume.

## Related

[Rate limiting](/security/rate-limiting) · [Attack prevention](/security/attack-prevention) · [Error standard](/reference/error-standard)
