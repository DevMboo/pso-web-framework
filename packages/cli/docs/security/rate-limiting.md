---
title: Rate limiting
description: Token-bucket limits per client, per principal and per route, local or shared through an optional Redis, with explicit failure policies.
order: 9
status: partial
keywords: [rate limit, 429, redis, trusted proxy, X-Forwarded-For, Retry-After, http.rateLimit]
related: [reference/error-standard, orchestrator/upstream-clients, security/secure-routing]
---
> [!STATUS]
> Implemented and verified for the **TypeScript orchestrator** and for **Spring Boot services**, each against a real Redis shared by several real instances. Both runtimes run the same behavioral contract. Rate limiting is one layer, not DDoS protection.

## What is limited

1. **Every client address** (before authentication): one budget per address, `http.rateLimit.perMinute` (default 600). Health probes are never limited.
2. **Every authenticated principal** (after the guards ran, `perPrincipal` default `true`): a budget of its own per `sub`, so a noisy caller cannot exhaust another caller's budget behind a shared address.
3. **Routes with their own policy** (`http.rateLimit.routes`): a stricter, route-specific budget on top of the above, keyed by principal or address.

Each budget is a token bucket: `burst` tokens (default = the per-minute limit), refilled at the configured rate. A refused request gets `429` with `Retry-After` and `RateLimit-*` headers, as a [problem](/reference/error-standard) (`PSO_RATE_LIMITED`). Key cardinality is bounded (`maxKeys`, least-recently-used eviction in the local provider; keys expire in Redis).

## Providers

| Provider | Use | Notes |
|---|---|---|
| `local` (default) | development, one instance | in-process; each instance has its own budget |
| `redis` | several instances sharing one budget | one atomic Lua script per decision, time taken from the Redis server (instance clock skew cannot grant extra tokens). Needs the `ioredis` package. Nothing connects unless `provider: redis` is set |

When the Redis backend fails, the **policy is explicit**: `onFailure: closed` (default, secure) answers `503 PSO_RATE_LIMIT_UNAVAILABLE`; `open` lets the request through. In production a non-local Redis must use `rediss://`. The Redis URL is a secret: set it with `RATE_LIMIT_REDIS_URL` or reference it as `"${env:NAME}"`; a URL with credentials written into a file is refused, and URLs are never logged.

## Client identity and proxies

The client address is the TCP peer. `X-Forwarded-For` is honoured **only** when the peer is in `trustedProxies` (IPs or CIDR); the chain is read from the right, skipping trusted hops, so a client cannot choose its identity by prepending values. Garbage in the chain never selects an identity.

## Spring Boot

```yaml
pso:
  limits:
    requests:
      per-minute: 600
      burst: 100
      per-principal: true
      provider: redis                       # needs com.pso:pso-ratelimit-redis-starter
      redis-url: ${RATE_LIMIT_REDIS_URL:}   # a secret: from the environment
      on-failure: closed
      trusted-proxies: [ "10.0.0.0/8" ]
      routes:
        - { route: "POST /customers", limit: 10, window-seconds: 60, burst: 5 }
```

Stage 1 is a servlet filter (per client address, before authentication); stage 2 is a handler interceptor that runs once the route and the authenticated principal are known (per principal and per route policy). Route policies name the route **without** the service prefix. Counters are published as `pso.ratelimit.decisions{result}` when Micrometer is present. With `provider: redis` and no starter on the classpath, or a Redis that cannot be reached at start-up, the service refuses to start (the message never contains the URL). With the default provider nothing ever connects to Redis, even when the starter is present.

## Configuration (orchestrator)

```json title="pso.config.json"
{ "http": { "rateLimit": {
    "perMinute": 600, "burst": 100, "perPrincipal": true,
    "provider": "redis", "redisUrl": "${env:RATE_LIMIT_REDIS}", "onFailure": "closed",
    "trustedProxies": ["10.0.0.0/8"],
    "routes": [ { "route": "POST /users", "limit": 10, "windowSeconds": 60, "burst": 5 } ]
} } }
```

Precedence, lowest to highest: defaults, `pso.config.json`, `pso.config.<environment>.json`, `PSO_CFG_http__rateLimit__perMinute`, then the documented variable (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`, `RATE_LIMIT_PROVIDER`, `RATE_LIMIT_REDIS_URL`, `RATE_LIMIT_FAILURE`, `RATE_LIMIT_PER_PRINCIPAL`, `RATE_LIMIT_MAX_KEYS`, `RATE_LIMIT_PREFIX`, `RATE_LIMIT_TRUSTED_PROXIES`). The same precedence applies to the HTTP limits (`http.limits.*`, see [Remote service clients](/orchestrator/upstream-clients)). `routes` is read from `pso.config.json` only. `perMinute: 0` disables the global limit. Every invalid value stops start-up with a message that names the setting.

Counters (allowed, denied, backend failures, keys) are available from the limiter; there is no export to a metrics system yet ([Dispatch security and observability](/dispatch/security-and-observability) lists what exists).

## What it looks like (verified)

A gateway configured with a budget of 3 requests per minute (`{ "http": { "rateLimit": { "perMinute": 3, "burst": 3 } } }` in `pso.config.json`), called five times from one client:

```text evidence="verified"
request 1: HTTP 503  ratelimit-limit: 3  ratelimit-remaining: 2
request 2: HTTP 503  ratelimit-limit: 3  ratelimit-remaining: 1
request 3: HTTP 503  ratelimit-limit: 3  ratelimit-remaining: 0
request 4: HTTP 429  ratelimit-limit: 3  ratelimit-remaining: 0  ratelimit-reset: 20  retry-after: 20
request 5: HTTP 429  ratelimit-limit: 3  ratelimit-remaining: 0  ratelimit-reset: 20  retry-after: 20
health during the limit: HTTP 200
```

(The first three answered `503` because the upstream behind that route was not running: they were admitted by the limiter and then failed downstream. The point is the headers and the fourth request.) The refused request's body:

```json
{"type":"urn:pso:problem:rate-limited","title":"Too many requests","status":429,"detail":"The rate limit was exceeded; retry after the interval given in Retry-After.","code":"PSO_RATE_LIMITED","error":"too_many_requests","instance":"/customers/ping","correlationId":"doc-rl-0004"}
```

and the log shows only the final status (`status=429`); health probes are never limited.

## Variations and decision

| You want | Do |
|---|---|
| a rough per-instance cap | the default local provider |
| one budget across instances | `provider: redis` ([local or distributed?](/decisions/local-or-distributed-rate-limit)) |
| a stricter limit for login | a route policy under `http.rateLimit.routes` |
| a budget per caller | `perPrincipal` (default true) |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| everyone is limited together | behind a proxy, every request has the proxy's address: configure `trustedProxies` |
| clients can choose their own identity | `X-Forwarded-For` trusted from anywhere: restrict `trustedProxies` to your proxies |
| `503 PSO_RATE_LIMIT_UNAVAILABLE` | the Redis backend failed with `onFailure: closed` (the secure default): restore Redis, or choose `open` knowingly |
| limits differ between instances | the local provider is per instance: use Redis |

## Common mistakes

- Treating the limiter as DDoS protection.
- Raising `perMinute` by the number of instances to "compensate".
- Forgetting that the `Retry-After` value is what a polite client should honour.

## Next steps

- [Local or distributed rate limiting?](/decisions/local-or-distributed-rate-limit)
- [Attack prevention](/security/attack-prevention)
