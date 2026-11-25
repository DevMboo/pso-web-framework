---
title: FEI and MEI security model
description: The frontend trust model stated plainly: what the shell protects, what the browser cannot protect, how remote code, tokens, redirects, CSRF and content policy are handled, and which claims PSO deliberately does not make.
order: 8
status: implemented
keywords: [security, trust model, content security policy, xss, csrf, open redirect, token, module federation, integrity, signature, sandbox]
related: [frontend/authentication-and-api, frontend/releases, security/checklist, security/attack-prevention]
---
> [!STATUS]
> **Implemented and verified** by unit tests and real-browser negative scenarios (tampered chunk and entry refused by integrity, untrusted signer refused, missing release, unauthorized route, strict CSP with no violations). Items marked "not provided" are limits, not oversights.

## The trust model in four sentences

The **orchestrator and the services** are the security boundary: they verify tokens (JWT/JWKS), scopes, tenants and business rules on every request. The **browser is not trusted**: every check in a guard, a middleware or a hidden button is a user-experience decision that anyone with developer tools can bypass. **Module Federation runs trusted remote code in the same JavaScript context as the shell**: it is not a sandbox, and PSO does not claim client-side code can contain a malicious microfrontend. So **every MEI is held to the same release standard as the shell**.

## What PSO does about it

| Risk | Control |
|---|---|
| Wrong or swapped remote code | locations come from the runtime configuration; manifests are hashed and optionally Ed25519-signed; scripts load with Subresource Integrity; same-origin or listed HTTPS origins only |
| Tampered file on the server | SRI makes the browser refuse it (verified for an entry and a chunk) |
| Incompatible release reaching users | contract and shared-dependency checks at publish time, again at load time |
| Token theft by another MEI | the token is held inside the session manager; the shared context has no token, refresh or setter; the `api` client attaches it |
| Credentials in bundles | none are generated; `PSO_ALLOW_DEV_TOKEN` is the only credential-related build switch and shows a banner |
| Open redirect | `returnTo`, `navigate()` and middleware redirects accept only absolute paths inside the application |
| Arbitrary backend URLs | the API client refuses absolute URLs, `//host`, `..` and backslashes before a request exists |
| Direct broker access | Channels only; Dispatch brokers are never browser-facing |
| Path traversal | route files, manifest paths and release paths must stay inside their directory |
| XSS | React escapes by default; the templates use no `dangerouslySetInnerHTML`; the generated nginx policy forbids inline and remote scripts |
| Conflicting session refreshes | one shared, in-flight refresh for the whole application |
| Credential leakage in logs | `redact` removes bearer tokens, JWTs and secret-looking fields |

The generated Content-Security-Policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The whole Commerce workflow was run under it with no violations.

## CSRF and cookies

The default is bearer tokens in memory, sent in the `Authorization` header: no ambient credentials, so no CSRF. The client can send an `X-CSRF-Token` and use same-origin credentials for a cookie-based session, but **orchestrator-backed sessions are not implemented**, so that path exists in the client and is not exercised.

## Not provided

- Containment of a malicious microfrontend. Use review, signing and restricted publish rights.
- Verification of a token signature in the browser. It would add nothing: the server does it.
- A real identity provider. Authorization Code with PKCE is implemented and unit-tested against a fake provider; run it against yours before relying on it.
- Protection against someone who can write the site root: they can publish a release signed with a key you trust only if they hold that key, but they can re-point `active.json` to an older signed release.

## What was checked against a real deployment

- **Orchestrator-only.** The production bundles of the Commerce shell and the three microfrontends contain no backend host, port, private address or credential. In Chrome the page talked only to its own origin and to the identity provider, every business call went through the orchestrator's prefix with a bearer token, and the identity provider's token endpoint was the only cross-origin call (declared in `connect-src`). Module Federation is not a sandbox and a JavaScript wrapper cannot stop arbitrary browser requests: the Content-Security-Policy (`default-src 'none'`, `script-src 'self'`, `connect-src` limited to the site and the declared provider, `frame-ancestors 'none'`) and private backend networking are what do that.
- **The orchestrator does not trust the interface.** Directly, without the frontend: no token gave 401; a token with a tampered payload and an `alg: none` token gave 401; a user with no commerce scopes got 403; a read-only user could read and got 403 on a write; the refusal body is RFC 9457 `application/problem+json`. A user the shell denies is also denied by the orchestrator.
- **A Java service reads `scope` and `scp` together** (the framework's starter used to read only the first, which dropped the permissions of a Keycloak token). Services were rebuilt with the fix.
- **Release trust.** A microfrontend is loaded only from an approved release whose manifest hashes verify; when the site requires signatures the manifest's ed25519 signature must verify against a key listed in the runtime configuration, and a valid checksum on unsigned or unauthorized metadata is not trusted. Integrity is never silently disabled.

## Common mistakes

- Treating a hidden button as authorization. Add the scope to the route in the orchestrator.
- Building production with `--allow-dev-token`. It is for validation environments; it prints a banner on purpose.
- Allowing `unsafe-inline` or a CDN origin in the content policy to make something work. Fix the cause.
- Putting an API key into `FEI.pso.ts`: declarations are literals that end up in the source tree, and the runtime configuration holds no secret by design.
