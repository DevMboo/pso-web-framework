---
title: Request and upload limits
description: Declarative body, multipart, header, timeout, rate and concurrency limits and exactly where each one is enforced.
order: 6
status: partial
keywords: [limits, body size, multipart, upload, rate limit, concurrency, timeout, 413, 429, 503]
related: [spring/configuration, security/rate-limiting, security/attack-prevention]
---
```yaml
pso:
  limits:
    requests: { enabled: true, per-minute: 600 }
    body: { max-size: 2MB }
    multipart: { enabled: false, max-file-size: 5MB, max-request-size: 10MB }
    header: { max-size: 16KB }
    timeouts: { connection: 10s, async-request: 30s }
    concurrency: { max-requests: 0 }
```

| Limit | Enforced by | Result |
|---|---|---|
| `body.max-size` | a servlet filter that counts the bytes **actually read** (so chunked bodies and a lying `Content-Length` cannot bypass it) and answers a declared oversize body before reading it | `413` |
| `multipart.*` (uploads through [PSO Storage](/spring/storage) need `enabled: true` and sizes at least as large as `pso.storage.upload.max-size`) | `multipart.enabled=false` rejects `multipart/form-data` before any controller; when enabled the container's multipart limits apply (per file and per request, mapped to `spring.servlet.multipart.*`) | `415` / `413` |
| `header.max-size` | the servlet container (`server.max-http-request-header-size`) | `431` or `400` |
| `timeouts.connection` | the container (`server.tomcat.connection-timeout`): slow-client protection | connection closed |
| `timeouts.async-request` | `spring.mvc.async.request-timeout` | `503` |
| `requests.*` | token-bucket rate limiting per client address, per authenticated principal and per route; in-process by default, shared through Redis with the optional `pso-ratelimit-redis-starter` | `429` + `Retry-After` as a [problem](/reference/error-standard) |
| `concurrency.max-requests` | a semaphore: requests beyond the limit are rejected immediately | `503` + `Retry-After` |

The declarative limits are translated into the real Spring Boot properties at the **lowest precedence**: an explicit `server.*` or `spring.*` property still wins. Health probes are exempt from the rate and concurrency limits.

## What the rate limiter is not

- It is not DDoS protection: it protects one process from one noisy client. Put a gateway, WAF or load balancer in front for volumetric attacks.
- The key is the socket's remote address. `X-Forwarded-For` is read **only** when the peer is listed in `requests.trusted-proxies` (IPs or CIDR), and then from the right, so a client cannot choose its identity.
- The default provider is per instance. For one budget shared across instances add `com.pso:pso-ratelimit-redis-starter` and set `requests.provider: redis`; see [Rate limiting](/security/rate-limiting) for the full model, the failure policy and the settings. A custom `RateLimiter` bean from earlier versions still replaces the client stage unchanged.

## Inbound and outbound

These limits apply to **inbound** HTTP to this service. Outbound calls have their own limits (timeouts, retries and response size) in [PsoHttpClient](/spring/http-client).

## Common mistakes

- Raising the body limit globally for one upload endpoint.
- Leaving `per-minute` at the local value in production (`6000` locally, `300` default in `prod`).
- Counting on in-memory rate limiting with several instances: use the Redis provider ([decision](/decisions/local-or-distributed-rate-limit)).
- Naming a route policy with the service prefix: route policies name the route **without** it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `413` on a legitimate upload | `pso.limits.body.max-size` (default 2 MB); multipart is disabled unless enabled |
| `431` or `400` | header size above `pso.limits.header.max-size` (the servlet container decides which) |
| `429` for everyone behind a proxy | configure `trusted-proxies` |
| `503` from the limiter | the Redis backend failed with `on-failure: closed` |

## Next steps

- [Rate limiting](/security/rate-limiting)
- [Spring configuration](/spring/configuration)
