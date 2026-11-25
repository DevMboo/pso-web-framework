---
title: Service identity and mutual TLS
description: Verified TLS and optional mutual TLS from the orchestrator to its upstream services, with explicit, audience-aware credential forwarding.
order: 10
status: partial
keywords: [mtls, mutual tls, tls, client certificate, service identity, trust store, certificate rotation, credential forwarding, audience]
related: [orchestrator/upstream-clients, security/authentication, reference/error-standard, spring/http-client]
---
> [!STATUS]
> Implemented and verified for the **TypeScript orchestrator** with a local certificate authority and real TLS servers. In **Spring** (`PsoHttpClient`) the same capabilities exist and are tested with real TLS: mutual TLS, mandatory validation, certificate **rotation without restart**, **audience-bound** forwarding and an extra service-identity pin (`tls.server-name`, which is stricter than the host name check rather than a replacement for it; see [Spring HTTP client](/spring/http-client)).

Two identities are kept apart:

| Identity | What it is | How it travels |
|---|---|---|
| **User** | the caller's own bearer token | forwarded only when the policy below allows it |
| **Service** | the orchestrator itself | a client certificate (mutual TLS); no shared password and no PSO-specific protocol |

## Verification is never optional

Certificate chain and host-name verification cannot be disabled: there is **no** "insecure" setting. A private CA is trusted explicitly with a CA file; a server whose certificate is expired, signed by another CA or names another service is refused with `502` [`PSO_UPSTREAM_TLS`](/reference/error-standard) and **no application data is sent to it**. `TLSv1.2` is the minimum.

## Per-upstream settings

Set them in `pso.config.json` (`http.upstreams.<name>`) or with variables named after the upstream (`users-service` becomes `USERS_SERVICE`):

| Variable | `pso.config.json` | Meaning |
|---|---|---|
| `PSO_UPSTREAM_<N>_TLS=true` | `tls.enabled` | use TLS (implied by any setting below) |
| `..._TLS_CA_FILE` | `tls.caFile` | PEM bundle of the CA(s) that issued the upstream's certificate |
| `..._TLS_SERVER_NAME` | `tls.serverName` | the identity the server certificate must carry (default: the host) |
| `..._TLS_CERT_FILE` + `..._TLS_KEY_FILE` | `tls.certFile`, `tls.keyFile` | the client certificate: enables **mutual TLS**; both are required together |
| `..._TLS_KEY_PASSPHRASE` | not allowed | a secret: environment only (the loader refuses it in a file) |
| `..._FORWARD` | `forward` | `none`, `bearer` or `inherit` (default: `security.propagation.forward`) |
| `..._AUDIENCE` | `audience` | forward the user's token only if it names this audience |
| `..._ALLOW_PLAINTEXT=true` | `allowPlaintext` | accept a non-TLS remote upstream in production (explicit risk) |

Values may be `"${env:NAME}"` references. The files are validated at start-up (they must exist, parse, and the key must match the certificate); a failure stops the application with a message that never contains key material or passphrases.

```json title="pso.config.json"
{ "http": { "upstreams": { "users": {
    "tls": { "caFile": "/etc/pso/ca.pem", "certFile": "/etc/pso/gateway.crt", "keyFile": "/etc/pso/gateway.key", "serverName": "users.internal" },
    "forward": "bearer", "audience": "users-api"
} } } }
```

## Rotation

The certificate, key and CA files are checked (at most once per second) and the next connection uses the new material, so the platform can rotate certificates without restarting the orchestrator. A half-written or invalid replacement is ignored: the last good material keeps serving until a valid one appears.

## When the user's token is forwarded

All of these must hold: the route is guarded (a public route never carries credentials upstream), the upstream's policy allows it, the connection is TLS **or loopback** (a token never travels in clear text between hosts, whatever the policy), and, when an `audience` is set, the token's `aud` includes it. Otherwise the request is sent without the `Authorization` header and a warning (without the token) is logged. Redirects from an upstream are never followed.

## Production

In production (`PSO_ENV` or `NODE_ENV` = `production`) an upstream that is not loopback must use TLS unless `allowPlaintext` is set; otherwise start-up fails. Local development stays simple: loopback upstreams work in plain HTTP, and a self-signed development CA is configured explicitly with `caFile`.

## Not provided

Verification of a specific certificate fingerprint or SPIFFE identity (use `serverName` and your CA), automatic issuance of certificates, token exchange and client-credentials flows (the orchestrator forwards the user's token or nothing), and service identities inside Spring beyond the existing trust-store/key-store settings.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `502 PSO_UPSTREAM_TLS` | the upstream certificate is expired, signed by another CA or names another service: configure `tls.caFile` and `tls.serverName`; certificate verification cannot be disabled |
| start-up refuses with a TLS configuration message | a file is missing, does not parse, or the key does not match the certificate; the message never contains key material |
| production start-up refuses a plaintext upstream | a non-loopback upstream needs TLS unless `allowPlaintext` is set explicitly |
| the user's token is not forwarded | the upstream's policy, the transport (TLS or loopback) and the token audience must all allow it; the log says `bearer token not forwarded to upstream  reason=...` |
| a rotated certificate is not picked up | the orchestrator reloads certificate files when their signature changes; check the file really changed and is readable |

## Common mistakes

- Treating mutual TLS as user authentication: it identifies the **service**.
- Forwarding the user's token to every upstream; bind it with `audience`.
- Putting the key passphrase in a file: only the environment is accepted.

## Next steps

- [TLS and mTLS](/security/tls-and-mtls)
- [Spring HTTP client](/spring/http-client)
