---
title: Security model, certificates and secrets
description: TLS on every hop, mutual TLS, the development certificate authority, operator-supplied certificates, JWT keys and JWKS, the identity provider's clients, secret references and how PSO keeps key material out of files, images, logs and Studio.
order: 4
status: implemented
keywords: [tls, mtls, certificate authority, certificates, jwks, jwt, keycloak, oidc, secrets, rotation, permissions, redaction]
related: [infrastructure/contract, infrastructure/resource-lifecycle, security/authentication, frontend/security]
---
## TLS on every hop

In the generated container topology every connection that carries a credential is TLS, verified against the environment's authority and the peer's name:

```architecture title="Hops of the container topology"
Browser (client)
  edge (proxy) # TLS for every public host; unknown hosts are refused (handshake fails or 421)
Edge network
  shell containers (shell) # static, public files only: no credential reaches them
  orchestrator (orchestrator) # inbound TLS (PSO_HTTP_TLS_CERT_FILE), verified by the edge as "gateway"
  identity provider (security) # TLS, verified by the edge as "idp"
Internal network
  services (service) # TLS; mutual TLS when services.<name>.mtls is true
  databases (database) # one per service, password from a secret file
```

The orchestrator terminates TLS itself (0.2.0: `PSO_HTTP_TLS_CERT_FILE`, `PSO_HTTP_TLS_KEY_FILE`, optional `PSO_HTTP_TLS_CLIENT_CA_FILE` for inbound mutual TLS), so the hop behind the edge is encrypted too. With `"mtls": true` a service requires a client certificate issued by the environment's authority; the orchestrator presents its own client identity (`cert:<orchestrator>-client`). The reference workspace verifies it for real: a client without a certificate gets `tlsv13 alert certificate required` from `accounts`.

## Certificates

- **Development** (`tls.source: "pso-dev-ca"`): PSO creates one authority per environment and one certificate per container, ECDSA P-256, with exactly the names its clients verify (the container name, `localhost` for its own health check, and the public hosts for the edge). The authority exists only on this machine; PSO never installs it in a system trust store. A browser trusts it only if you install it yourself (the validation scenarios pin the edge certificate's public key instead).
- **Staging and production** (`tls.source: "external"`): the operator supplies the files in the same layout (`ca.crt`, `<name>/tls.crt`, `<name>/tls.key`). PSO verifies them where they are (chain, key, names, validity) and mounts them read-only; it never writes them and never generates production certificates.
- **Expiry**: certificates closer than 30 days to expiry are warnings in `pso infra:plan`, `infra:status`, `infra:validate` and Studio. Nothing is replaced silently; `pso infra:rotate` replaces on purpose.

## Identity provider, JWT and JWKS

- `keycloak`: PSO generates the realm: one role per scope found in the declarations, one public OIDC client per shell (Authorization Code with PKCE S256, redirect URIs and web origins computed from the shell's host, base path and development server), an audience mapper (`pso-api`) and a role-to-`scp` mapper. Development users get generated passwords (placeholders in the realm, resolved from secret files when Keycloak starts). A development-only confidential client (`pso-api-client`) serves request tools such as the Studio API Client.
- The `iss` claim is the address the browser uses (`https://auth.<domain>:<port>/realms/<realm>`); services fetch the keys from the provider's internal name. That binding is declared explicitly (`PSO_JWT_JWKS_TRUSTED_HOSTS`, `PSO_JWT_JWKS_PRIVATE_HOSTS`, the authority in `PSO_JWT_JWKS_CA_FILE`): the orchestrator refuses a key host that is not bound to the issuer.
- `pso-dev`: an ES256 signing key in `.infra/identity/<env>/signing-key.pem`, public keys served by the edge; `pso infra:token --user <name>` signs development tokens. Refused in production.
- `external`: PSO only configures issuer, audience and JWKS from the contract.

## Secrets

Generated configuration contains **references**, never values. A service receives a secret as a file under `/run/secrets` (Compose secrets); Spring reads it as a configuration property through `configtree`, Postgres through `POSTGRES_PASSWORD_FILE`, Keycloak through a start script that reads the file. No value appears in the compose file, the environment section, an image or a log. One provider per environment:

| Provider | Value lives in | Allowed in |
|---|---|---|
| `local` | `.infra/secrets/<env>/<name>`, owner-only | development |
| `env` | `PSO_SECRET_<NAME>` injected by the platform | all |
| `file` | `<secrets.dir>/<name>`, a mounted secret file | all |

For local processes, `.infra/env/<env>/<service>.env` holds `DB_PASSWORD=secret://db-catalog`; `pso dev` resolves the reference into the child's environment at start.

## What the edge reveals

Nothing about its software: no `Server` or `X-Powered-By` header, no nginx error page, no internal status (plain HTTP on the TLS port is a sanitized `400`). Errors the edge produces itself are an HTML page for a browser and an RFC 9457 document for an API; the orchestrator's and the identity provider's responses pass unchanged. See [Edge protection and native error responses](/infrastructure/edge-protection).

## What PSO never does

- install an authority or change a system trust store, edit the system hosts file without `--apply --yes`, or create DNS records;
- generate certificates, keys or secrets for staging or production;
- print key material or secret values: `pso infra:inspect` and Studio show fingerprints, names, dates, sources and lengths; every log line and `docker:logs` output is redacted (private keys, JWTs, `password=`/`token=` values, bearer tokens and every secret value PSO has seen);
- commit or bake secrets: `.infra/` is ignored, `pso infra:validate` fails when a secret value appears in a generated file, in `.env` or in the 0.1 compose file, or when `.infra/secrets` is tracked by git.

## Limits
- The development authority is not a PKI: no revocation, no hardware key protection, no audit trail. It exists so that development runs with real verification.
- Response bodies in the Studio API Client are masked only for values PSO knows are secret; a service that returns another credential in its body shows it to the developer who sent the request.
