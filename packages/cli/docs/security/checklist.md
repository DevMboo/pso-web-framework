---
title: Production security checklist
description: What to verify before exposing a PSO application - each item with the command or file that proves it, and what a failure means.
order: 10
keywords: [checklist, production, hardening, security:check, tls, rate limit, secrets]
related: [security/auditing, devops/build-and-deploy, concepts/security-by-default, devops/cloud-descriptors]
---
Work through the list with the **proof** column, not from memory.

## Identity and access

- [ ] `pso validate` and `pso security:check --strict` pass with no high or critical findings. *Proof: both exit 0 in CI.*
- [ ] `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` and a key source are set in the orchestrator **and** every service; the algorithm list is as narrow as your provider allows. *Proof: `pso config:show --service <name> --env production`; services refuse to start in `prod` without them.*
- [ ] The key source is a JWKS served over https from your identity provider; no development keys from `pso security:keys` are used. *Proof: `PSO_JWT_JWKS_URI` is https; `keys/` is absent from the deployment.*
- [ ] Every route is `public: true` on purpose or guarded; no public state-changing route. *Proof: `pso security:policy`, and the `info` list in `security:check`.*
- [ ] Scopes are specific and defined for every guarded route; ownership is checked in the services. *Proof: review of `ROUTES.pso.ts` and service tests for forbidden and anonymous callers.*

## Network and transport

- [ ] TLS terminates in front of the orchestrator; services are on a private network and not published. *Proof: only the orchestrator's port is reachable from outside.*
- [ ] East-west traffic: upstreams use TLS (required in production for non-loopback hosts unless `allowPlaintext` is set), with mutual TLS where the service must know the caller. *Proof: `http.upstreams.<name>.tls` settings; no `allowPlaintext` you cannot justify ([TLS and mTLS](/security/tls-and-mtls)).*
- [ ] Trusted proxies are configured so the real client address is used. *Proof: a request through the proxy is rate-limited per client, not per proxy.*
- [ ] Rate limiting is sized and, with several instances, shared (Redis) ([decision](/decisions/local-or-distributed-rate-limit)); also applied at the proxy or edge. *Proof: a burst test returns `429` with `Retry-After`.*
- [ ] `server.host` is not `0.0.0.0` outside containers. *Proof: `SEC009` absent.*

## Secrets and supply chain

- [ ] No secrets in source, configuration, images or logs; `.env` and private keys are git-ignored and in `.dockerignore`. *Proof: `SEC001`, `SEC008`, `SEC010` absent; `pso config:validate` has no `PSO_CONFIG_PLAINTEXT_SECRET`.*
- [ ] Dependencies are audited: `pso security:audit` for Node, plus your own Maven CVE scanning (PSO does not scan Maven dependencies). *Proof: reports archived with the release.*
- [ ] Release artifacts are immutable (no SNAPSHOT) and deployment goes through `pso deploy --yes` with a health URL; release checksums and the SBOM are kept ([distribution](/devops/distribution-and-installation)).

## Operations

- [ ] Logs are collected as JSON (`PSO_LOG_FORMAT=json`, Spring `prod` profile) and correlation ids are traced across the orchestrator and services ([logging](/devops/logging)).
- [ ] Alerts exist for `ERROR`/`FATAL`, for non-empty Dispatch dead-letter channels and for the missing `orchestrator listening` line after a deploy.
- [ ] Backups and restore of every database are tested (PSO does not manage them).
- [ ] You have read what is **not** provided: [Security by default](/concepts/security-by-default), [TLS and mTLS](/security/tls-and-mtls), [Rate limiting](/security/rate-limiting).

## Troubleshooting a failed item

| Item | If it fails |
|---|---|
| `security:check` finding | the finding has a `fix:` line; apply it, re-run |
| a service starts without JWT settings in production | it should not: check the active profile (`SPRING_PROFILES_ACTIVE=prod`) |
| a route is public by mistake | change `ROUTES.pso.ts`, redeploy, and review access logs for the exposure window |
| a key was committed | rotate immediately ([keys](/security/keys-and-pem)); treat as compromised |

## Next steps

- [Security auditing](/security/auditing)
- [Cloud descriptors](/devops/cloud-descriptors)
