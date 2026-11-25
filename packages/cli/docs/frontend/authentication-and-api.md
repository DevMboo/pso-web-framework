---
title: Authentication, the API client, typed contracts and Channels
description: How the shell signs users in and keeps the session, how every request reaches only the orchestrator through a native-fetch client, how typed contracts are generated from the orchestrator, and how real-time events reach microfrontends.
order: 5
status: partial
keywords: [authentication, pkce, oidc, jwt, session, api client, fetch, problem details, contracts, channels, websocket, csrf, token]
related: [frontend/security, frontend/routing-and-middleware, security/authentication, concepts/contracts]
---
> [!STATUS]
> **Implemented and verified.** The API client, session handling, PKCE flow, contract generation and the Channels manager are verified by unit tests. In a real browser: the client, a pasted development token, orchestrator requests, a real `order.updated` Channels event, and **Authorization Code with PKCE against a real Keycloak** (22 of 22 checks: sign-in, the token accepted by the orchestrator, authorization enforced independently of the interface, sign-out). The infrastructure engine provisions that Keycloak for local environments (`pso infra:init`). **Not implemented:** orchestrator-backed cookie sessions (the orchestrator has no session endpoint).

## Sign-in and session

The shell owns sign-in. The runtime configuration (a file the deployment publishes, never built into the bundle) selects the provider:

- `oidc`: Authorization Code with PKCE (S256), `state` and `nonce`. The code verifier is single use and held only for the redirect. Redirect targets after sign-in (`returnTo`) must be paths inside the application.
- `dev-token`: a pasted token, for development. It works in development builds, or in a production build made with `pso frontend:build --allow-dev-token`, which shows a permanent warning banner. It is refused otherwise.

The access token lives in the memory of the shell's session manager. It is not in React state, not in the shared context and not in `localStorage` or `sessionStorage` (development builds keep a pasted token in `sessionStorage` so a reload does not ask again; production does not). A reload therefore signs the user out and, after signing in, returns them to the page they asked for. Token claims are decoded for display only; the orchestrator verifies the signature, issuer, audience, scopes and tenant.

**What the shell checks at sign-in** (tested against a real Keycloak in Chrome): the provider's endpoints must be https (plain http only for localhost); the callback must carry the `state` this browser created; an ID token must have the configured issuer, this client as audience (and as authorized party when there are several audiences), be unexpired and carry **this sign-in's nonce** (a missing nonce is a mismatch); an access token from another issuer is refused. The ID token's signature is not verified in the browser (it came straight from the token endpoint over TLS, which OIDC Core allows); the orchestrator verifies the access token on every request. A callback page that mounts twice redeems the single-use code once. **Logout** ends the provider's session (RP-initiated, with the ID token as hint and a post-logout redirect inside the application). **Session restoration:** the token is memory-only, so after a reload the shell asks the provider silently (`prompt=none`) if a flag in `sessionStorage` says this tab had a session; `login_required` is not an error and drops the flag, so there is no loop; `restoreSession: false` switches it off. **Scopes** are read from the configured claim and from `scp` together, because providers differ (Keycloak and Azure AD keep OIDC scopes in `scope` and permissions in `scp`). The orchestrator reads both too.

## Session strategies

Supported: **bearer tokens with PKCE** (above). Not provided: cookie sessions. The orchestrator-backed HttpOnly-cookie session was evaluated and not added: a PKCE flow whose token lives in memory and whose renewal is shared satisfies the requirements without a server-side session store, CSRF tokens and rotation that would need their own review. If you add cookie sessions yourself, keep them additive next to bearer tokens, `HttpOnly`, `Secure` and `SameSite`, with CSRF protection on unsafe methods (the client already sends a CSRF header when configured for cookies). Limits: a token cannot be revoked before it expires (keep access-token lifetimes short; Keycloak's server-side logout stops the next renewal, which was verified); a refresh token held in memory is lost on reload and restored through the provider session, not stored.

Sessions expire: a timer refreshes shortly before expiry when the provider issued a refresh token, **one refresh at a time for the whole application** however many microfrontends have requests in flight, and otherwise ends the session. Sign-out is broadcast to other tabs.

## The API client

```typescript
const { api } = usePsoContext();
const customers = await api.get<Customer[]>("/customers");
const created = await api.post<Customer>("/customers", { name, email });
```

Built on native `fetch`: a configured same-origin base path plus a validated relative path (an absolute URL, `//host`, backslashes, `..` and control characters are refused before a request exists), JSON, query parameters, cancellation, timeouts, a correlation id on every request, and RFC 9457 Problem Details turned into `PsoApiError` (`status`, `problem`, `fieldErrors`, `correlationId`). Failures are classified: problem, http, network, timeout, cancelled, invalid response, refused.

**Retries are conservative.** GET (and other idempotent methods) may be retried after a network error or 502, 503 or 504; a POST is **never** retried automatically unless the caller supplied an idempotency key. After a 401 the client performs one shared refresh and repeats only idempotent requests. `dedupe: true` lets concurrent identical GETs share one call.

## Typed contracts

```bash
pso frontend:contracts
pso frontend:contracts --check
```

Generates `src/models/contract.generated.ts` in every frontend project from the orchestrator's real route metadata and the DTO classes its controllers validate. It contains the request DTO types, a table of operations (method, path, scopes, authentication) and `ORCHESTRATOR_CONTRACT_VERSION`. **Response types exist only where the orchestrator declares them.** A route may publish an optional `responses` block in its `ROUTES.pso.ts` entry; nothing is inferred from a running service or from samples, and a route without the block keeps working and stays untyped (`unknown`). `pso frontend:validate` warns when a project's copy is older than the orchestrator and `--check` fails in CI.

```typescript evidence="illustrative"
{
  method: "GET", path: "/customers/:id", controller: CustomersController, action: "findById",
  security: { guard: "jwt", scopes: ["customers:read"] },
  metadata: { service: "customers" },
  responses: { 200: "CustomerResponse", 401: "problem", 403: "problem", 404: "problem" }
}
```

Values name a `@Dto()` class of the orchestrator (`"CustomerResponse"`, `"CustomerResponse[]"`, `"CustomerResponse | null"`), `"void"` for no body or `"problem"` for an RFC 9457 body. A response-only DTO is complete unless a field is declared with `?`. Pagination is a DTO you declare (`CustomerPage { items: CustomerResponse[]; total: number }`): PSO does not invent an envelope. The orchestrator does not validate what the service answers, so keep the DTO in step with the service; the `responses` block is metadata for typed frontends, not enforcement.

**Why responses are not validated at runtime.** Checking every response in the orchestrator was evaluated and is not on by default. The orchestrator forwards the service's body; validating it means buffering and parsing every response (it would break streaming and large downloads and add latency and memory to the one component all traffic crosses), and a mismatch has no good production answer (a 500 turns a harmless extra field into an outage, passing it through makes the check decorative). The service owns its response, so the check belongs where the answer is produced: contract tests of the service against the declared `responses`, run in CI, and the breaking-change report above. If an opt-in check is added later it should be per route, off in production, and report instead of failing.

The generated file also exports `createOperations(api)`, typed calls over the host's `api` (authentication, correlation, cancellation and error classification unchanged):

```typescript evidence="illustrative"
const ops = createOperations(usePsoContext().api);
const customers = await ops.call("GET /customers");                              // CustomerResponse[]
const one = await ops.call("GET /customers/:id", { params: { id } });             // CustomerResponse
const created = await ops.call("POST /customers", { body: { name, email } });    // body checked against the DTO
```

The compiler rejects an operation that is not in the contract, a missing body, a body of the wrong type and a wrong use of the response. Path parameters are URL-encoded and can never add a segment or a query. When the orchestrator changes, `pso frontend:contracts` compares the new contract with the previous one and lists **breaking** changes (an operation, a response status or a field removed or retyped, a response field made optional, a request field made required, more scopes needed) apart from **additive** ones; `--fail-on-breaking` makes the command exit 1. Event payloads are not part of this contract yet.

## Channels

The shell owns one WebSocket connection. `channels.subscribe("order.<id>", handler)` shares one server-side subscription per channel across all listeners, closes it when the last listener leaves (so navigation leaves nothing behind), re-authenticates after a session change and reconnects within bounded attempts. A MEI never opens a socket, and Dispatch brokers are never exposed to the browser. Event delivery is at least once: handlers should re-read state (the Orders page treats an event as "it changed" and asks the orchestrator what it is).

## Keycloak as the provider, and moving a running workload to it

Keycloak is only an example of a standards-compliant provider; PSO needs an issuer, its keys, an audience and permissions in `scope` or `scp`. A deployment of it must not be a development one: a pinned, supported version, the production `start` mode with a real database, hostname and proxy settings that match the public address, HTTP only on the loopback behind managed HTTPS, a private management interface, a dedicated realm, a public client with Authorization Code and PKCE, explicit redirect URIs and secrets that never leave the server's secret store.

```architecture title="Target topology of the Azure validation server (proposed, not deployed)"
browser (client)
  shared nginx server on 443 (proxy) # HTTPS |
    gateway (orchestrator) # / | the only backend of the browser; validates tokens
      customers, catalog and orders (service) # forwards |
    Commerce frontend (shell) # /commerce/ | static files served from the site root
    Keycloak (security) # /idp/ | loopback only; management port private; its own database
```

The gateway and the services accept **one issuer each** (TypeScript and Java alike): there is no multi-issuer mode, and an unrestricted one would be unsafe, so none is offered. Moving a running workload from the test-token provider to Keycloak is therefore a controlled migration: deploy the four applications with the new issuer, JWKS location and audience as ordinary blue-green releases in a planned window (tokens of the old provider stop working as each one switches, so business requests fail briefly until all four are active), verify, and keep each previous release as the rollback. Nothing is left as an uncontrolled fallback: the development-token sign-in stays a build-time option that shows a warning banner and is not part of a production build.

## Channels, in more detail

Tested against the real Channels server on real sockets: one connection and one server-side subscription per channel however many microfrontends listen; one microfrontend leaving never removes another's subscription; a faulty listener never stops the others; sixty rapid mount and unmount cycles leave no connection, subscription or listener; a gateway restart is followed by reconnection with backoff, a fresh token and re-subscription; a rejected token ends in `closed` after the bounded number of attempts and the error carries no token; `close()` (logout) releases everything and nothing reconnects. Three defects were found and fixed: a subscription cancelled while its subscribe request was in flight stayed on the server, the retry budget was reset by any open socket so a rejected token retried forever, and the server refused rate-limited `unsubscribe` frames (it no longer charges them). In the local Commerce stack the order is decided immediately and no Channels server runs, so a live event is only demonstrated on a stack that has one.

## Limits and common mistakes

- Do not put the token in a MEI's own storage or request it from the shell: there is no API for it by design.
- A JavaScript wrapper cannot stop other code in the page from calling `fetch`. The boundary is the deployment: same-origin routing, `connect-src 'self'` and private service networks.
- A channel the user may not read answers with an authorization error from the server; the interface cannot grant it.
- Without Channels on the backend the Orders page polls every few seconds for a bounded number of times; it does not poll forever.
