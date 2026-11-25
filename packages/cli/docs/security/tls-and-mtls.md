---
title: TLS and mTLS
description: Which transport-security features PSO has - outbound TLS and mutual TLS from the orchestrator and from Spring services - which it does not (TLS termination), and what to put in front of the orchestrator today.
order: 5
status: partial
keywords: [tls, mtls, https, certificates, reverse proxy, termination, trust store]
related: [security/service-identity, security/secure-routing, devops/docker, spring/http-client]
---
> [!STATUS]
> **Outbound** TLS and mutual TLS (the orchestrator to its upstreams, and Spring services calling other services with `PsoHttpClient`) are implemented and tested with real TLS servers; the full guide is [Service identity and mTLS](/security/service-identity). **Inbound** TLS termination is **not** implemented in the orchestrator: there are no TLS options on its listener and no certificate management commands.

## What exists

| Capability | Where | Guide |
|---|---|---|
| verified TLS to an upstream, optional client certificate (mutual TLS), per-upstream CA, host-name pin, rotation by file change, audience-bound token forwarding | orchestrator (`http.upstreams.<name>`) | [Service identity](/security/service-identity) |
| the same for outbound calls, with trust and key stores | Spring (`pso.http.client.services.<name>.tls`) | [Spring HTTP client](/spring/http-client) |
| refusal of plain-http JWKS URLs (loopback excepted) | the JWT guard | [Authentication](/security/authentication) |
| a Compose file that publishes only the orchestrator, bound to `127.0.0.1`, with services on an internal network and verified TLS between the orchestrator and every service | `pso docker:init` | [Docker](/devops/docker) |
| development certificates (a local authority and one certificate per service) and a check of any supplied certificates: authority, dates, keys, names | `pso tls:init --dev`, `pso tls:check` | [Docker](/devops/docker#tls-the-default) |
| an expired or not yet valid authority or client certificate named at orchestrator start-up; a warning under 30 days | orchestrator start-up | [Service identity](/security/service-identity) |
| in production, a non-loopback upstream must use TLS unless `allowPlaintext` is set explicitly | orchestrator start-up | [Service identity](/security/service-identity) |

Certificate-chain and host-name verification cannot be disabled; there is no "insecure" option.

## What does not exist

- TLS on the **orchestrator's own listener**. It speaks HTTP.
- Certificate issuance, renewal or distribution commands.
- TLS configuration for the **inbound** side of Spring services beyond what Spring Boot itself offers (`server.ssl.*`), which PSO neither wraps nor generates.

## What to do today for inbound traffic

Terminate TLS in front of the orchestrator with a reverse proxy or your platform's load balancer, forward to `127.0.0.1:3000` or a private address, and enforce HTTPS redirects there.

```architecture title="Where TLS starts and ends"
client (client)
  load balancer / reverse proxy (proxy) # HTTPS |
    orchestrator (orchestrator) # HTTP, private network |
      services (service) # TLS or mTLS |
```

If the proxy is the TCP peer, tell the orchestrator which addresses are trusted proxies so rate limiting and logs see the real client ([local or distributed rate limiting](/decisions/local-or-distributed-rate-limit)). Restrict who can reach the orchestrator's port with network rules; do not expose it directly.

## Choosing for east-west traffic (orchestrator to services)

| Situation | Choice |
|---|---|
| same host, development | plaintext to loopback is allowed |
| private network, production | TLS is **required** for a non-loopback upstream unless you accept the risk explicitly |
| you want the service to know the caller is the orchestrator | mutual TLS: the orchestrator presents a client certificate |
| you run a service mesh | the mesh may provide mTLS; use `allowPlaintext` only knowingly, since PSO cannot verify what the mesh does |

## Distinguish the layers

Transport encryption protects a hop. It is not end-to-end application encryption: any intermediary that terminates TLS (including the orchestrator) sees the plaintext. PSO makes no end-to-end encryption claim.

## Common mistakes

- Exposing port 3000 directly to the internet.
- Setting `allowPlaintext` to silence a production start-up error instead of configuring TLS.
- Assuming a proxy that terminates TLS also gives the orchestrator the client address: it does only if you configure trusted proxies.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| start-up fails with "production requires TLS to non-loopback upstreams" | a remote upstream is plaintext and `PSO_ENV=production` | the `error` field of the log line | configure TLS for the upstream; use `allowPlaintext: true` only when something else encrypts the hop |
| the same address starts in development | the rule is for production; loopback and development are exempt | `PSO_ENV` | none: this is by design |
| `PSO_SEC_JWKS_INSECURE` | the JWKS URL uses plain http to a non-loopback host | the `detail` field | use https |

Both refusals were reproduced and are shown, with the exact log lines, in [Why the orchestrator refuses to start](/reference/startup-failures).

## Next steps

- [Service identity and mTLS](/security/service-identity)
- [Secure routing](/security/secure-routing)
