---
title: PsoHttpClient
description: Secure outbound HTTP to named services: destination policy, timeouts, size limits, TLS and mTLS, retries, bearer forwarding and error mapping.
order: 7
status: partial
keywords: [PsoHttpClient, http client, outbound, retry, tls, mtls, timeout, RestClient, pso-http-spring-boot-starter]
related: [spring/configuration, microservices/service-to-service, spring/security-and-cors]
---
```java
@Service
@RequiredArgsConstructor
public class CustomerService {

    private final PsoHttpClient http;

    public CustomerDto findCustomer(String id) {
        return http.get("customers", "/customers/{id}", CustomerDto.class, id);
    }
}
```

```yaml
pso:
  http:
    client:
      services:
        customers:
          base-url: https://customers.internal:8443
          connect-timeout: 2s
          read-timeout: 5s
          max-response-size: 2MB
          forward-bearer: false
          audience: users-api                       # with forward-bearer: only forward tokens whose audience includes this
          retry: { max-attempts: 2, backoff: 100ms, retry-non-idempotent: false }
          tls:
            trust-store: /etc/pso/trust.p12
            trust-store-password: ${TRUST_STORE_PASSWORD}
            key-store: /etc/pso/client.p12          # setting a key store enables mutual TLS
            key-store-password: ${CLIENT_KEY_PASSWORD}
            server-name: users.internal             # extra identity pin: the server certificate must also carry this name
```

The client is built on Spring's `RestClient` and the JDK `HttpClient`; there is no custom transport.

## API

`get`, `post`, `put`, `patch`, `delete` and `exchange(PsoRequest, Class)` (headers, `idempotencyKey`). `exchangeAsync` and `getAsync` return a `Future`; `cancel(true)` interrupts the call (best effort: the remote may still process it). Use `Void.class` for responses without a body.

## Destination policy

- The first argument must be a service declared under `pso.http.client.services`; otherwise `PsoHttpException` with kind `POLICY` is thrown **before any network I/O**.
- Paths are relative to the service's base URL. Absolute URLs, `//host`, backslashes, line breaks, dot segments and encoded separators are refused.
- URI variables are encoded, so a value cannot change the path.
- Redirects are **never followed**, so a remote cannot steer a call to another host.
- Plain `http` is refused for non-loopback hosts unless `allow-insecure-http: true`; credentials, query strings and fragments in `base-url` are refused. Invalid configuration stops start-up.

## Credentials and correlation

The caller's bearer token is forwarded only to services configured with `forward-bearer: true`, and it is taken from the **verified** authentication of the current request (never from a raw header). Without an authenticated caller nothing is forwarded. The correlation id of the current request is propagated, also through async calls.

## Retries

| Request | Retried on connection failure, timeout, 502/503/504 |
|---|---|
| GET, HEAD, PUT, DELETE, OPTIONS | yes, up to `max-attempts` with backoff and jitter |
| POST, PATCH | only with `retry-non-idempotent: true` **and** an `Idempotency-Key` header |
| any 4xx, TLS failures, policy and size errors | never |

## TLS

Certificate and host name validation are never disabled. A `trust-store` adds private CAs (the JVM trust store is used otherwise). A `key-store` enables mTLS. A failed handshake is reported as kind `TLS`; unreadable material stops start-up with a message that never contains passwords.

## Errors

`PsoHttpException` carries the service name, a kind (`POLICY`, `CONNECT`, `TIMEOUT`, `TLS`, `RESPONSE_TOO_LARGE`, `REMOTE_CLIENT_ERROR`, `REMOTE_SERVER_ERROR`, `CANCELLED`, `INVALID_RESPONSE`) and the remote status. Messages never contain the URL, query string, headers or the remote body. Responses over `max-response-size` fail while being read, with or without a `Content-Length`.

## Rotation, identity and audience

- **Rotation without restart.** The trust store and key store files are checked (at most once per second); when one changes the HTTP client is rebuilt and new connections use the new material. A corrupt or half-written replacement is ignored and the previous material keeps serving (a warning is logged).
- **`tls.server-name`.** The normal host name check always runs. When this is set the server certificate must **also** carry that name as a DNS or IP subject alternative name. It can only make verification stricter. (The Node orchestrator's `serverName` replaces the name used for verification instead; see [Service identity](/security/service-identity).)
- **`audience`.** With `forward-bearer: true` the caller's token is forwarded only if its `aud` claim includes the value; a token without audience is not forwarded. Whatever the settings, a token is never sent over plain `http` to a non-loopback host.

## Not implemented

Service discovery beyond the declared services (an environment-specific `base-url` is the supported way), circuit breakers and client-credentials token acquisition.

## What the failures look like

| Cause | Result |
|---|---|
| a service name not declared under `pso.http.client.services` | `PsoHttpException` of kind `POLICY`, thrown before any network I/O |
| an absolute URL, `//host`, dot segments or encoded separators in the path | refused by the destination policy |
| the remote answers with a redirect | not followed: the response is returned as is |
| plain `http` to a non-loopback host | refused unless `allow-insecure-http: true` |
| the remote's certificate does not verify | the call fails; verification cannot be disabled |
| a non-idempotent call (POST) that fails | not retried unless `retry-non-idempotent: true` |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `POLICY` exception for a service you configured | the key under `services` differs from the name you pass (names are exact) |
| the remote returns `401` | the caller's token is forwarded only with `forward-bearer: true` **and** a matching `audience`, and only when the current request has a verified user |
| calls fail only in production | TLS settings differ (trust store, `server-name`); check the remote's certificate names |
| duplicated side effects after a retry | enable retries only for idempotent calls, or send an `idempotencyKey` |

## TLS with PEM files (the same files the orchestrator uses)

A service that calls another service over HTTPS trusts its certificate authority with a PEM file: the very file the orchestrator uses as `PSO_UPSTREAM_<NAME>_TLS_CA_FILE`, that `pso.security.jwt.ca-file` uses for the identity provider and that `pso tls:init --dev` writes as `tls/ca.crt`. No conversion to a key store is needed.

```yaml title="application.yml"
pso:
  http:
    client:
      services:
        customers:
          base-url: https://customers:8082
          tls:
            ca-file: /run/pso/tls/ca.crt            # PEM: one or more authorities
            cert-file: /run/pso/tls/tls.crt         # optional, with key-file: mutual TLS
            key-file: /run/pso/tls/tls.key
            key-password: ${CUSTOMERS_TLS_KEY_PASSWORD:}   # only for an encrypted key
```

| Property | Meaning |
|---|---|
| `tls.ca-file` | PEM file with the trusted authorities. Without it (and without `trust-store`) the JVM trust store is used |
| `tls.cert-file`, `tls.key-file` | the client certificate (with its chain) and its private key (RSA or EC, PEM): mutual TLS. Both or neither |
| `tls.key-password` | password of an encrypted `key-file`; a secret, from the environment |
| `tls.trust-store`, `tls.key-store` (+ `-type`, `-password`) | the same two things as PKCS12 or JKS key stores. Still supported; use one form per purpose, not both |
| `tls.server-name` | the service identity the certificate must also carry |

Verification is never disabled, whatever the form: a certificate from an authority that is not trusted, a certificate for another host name and a missing client certificate all fail with `PsoHttpException.Kind.TLS`. The files are checked at start-up, and the message names the file and the reason, never a password or key content: `tls.ca-file not found`, `contains no certificate`, `the certificate authority in ... expired on 2026-01-31`, `tls.ca-file and tls.trust-store both name the trusted authorities`. `pso security:validate` reports the contradictory combinations before the service starts (`SPR014`).

## What the caller of your service sees when a remote call fails

A `PsoHttpException` you do not handle becomes a problem that never contains the remote service's body:

| The remote service | Problem |
|---|---|
| answered 404 | `404 PSO_UPSTREAM_NOT_FOUND` |
| answered 409 | `409 PSO_UPSTREAM_CONFLICT` |
| answered another 4xx | `502 PSO_UPSTREAM_REJECTED` (your service made a request the remote refused: that is not the caller's 400, 401 or 403) |
| answered 5xx, or something unreadable | `502 PSO_UPSTREAM_BAD_GATEWAY` |
| did not answer | `504 PSO_UPSTREAM_TIMEOUT`, `503 PSO_UPSTREAM_UNAVAILABLE`, `502 PSO_UPSTREAM_TLS` |

Earlier versions answered `502 PSO_UPSTREAM_BAD_GATEWAY` ("an upstream service returned an invalid response") for a remote 404 as well, which described a failure that had not happened. When a remote answer has a meaning in your domain, translate it on purpose:

```java title="src/main/java/com/pso/orders/application/service/CustomerLookup.java"
package com.pso.orders.application.service;

import com.pso.spring.http.PsoHttpClient;
import com.pso.spring.http.PsoHttpException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class CustomerLookup {

    public record Customer(String id, String name) {
    }

    private final PsoHttpClient http;

    public CustomerLookup(PsoHttpClient http) {
        this.http = http;
    }

    public Customer require(String customerId) {
        try {
            return http.get("customers", "/customers/{id}", Customer.class, customerId);
        } catch (PsoHttpException e) {
            if (e.isStatus(404)) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "unknown customer");
            }
            throw e;
        }
    }
}
```

## Common mistakes

- Building URLs by string concatenation instead of path templates (`/customers/{id}`): variables are encoded for you.
- Forwarding the user's token to every service.
- Disabling TLS checks to "make it work".

## Next steps

- [Service-to-service communication](/microservices/service-to-service)
- [Service identity and mTLS](/security/service-identity)
