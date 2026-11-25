---
title: Why the orchestrator refuses to start
description: Eight start-up failures of the orchestrator - TLS, JWT algorithm, key file, JWKS URL, rate limit, log level, port and a misspelled setting - each reproduced, with the exact log line, cause, fix and prevention.
order: 7
status: stable
keywords: [startup failed, PSO_SEC_ALGORITHM, PSO_SEC_PEM_PATH, PSO_SEC_JWKS_INSECURE, PSO_SEC_MISSING, PSO_CONFIG_INVALID_VALUE, PSO_CONFIG_UNKNOWN_KEY, allowPlaintext, config:validate, PSO_LOG_LEVEL]
related: [reference/diagnostics-catalog, security/security-configuration, security/tls-and-mtls, concepts/configuration, devops/environment-configuration, security/authentication, security/keys-and-pem]
---
The orchestrator would rather not start than run with a configuration it cannot defend. It checks security, limits and logging **before it opens a port**, and when a check fails it logs one structured error line and exits: **no route is active**. This page shows each refusal as it was produced, so that when you see one you know what it means.

How the evidence was produced: a generated workspace (`gateway` with one route guarded by the `jwt` guard, plus a `catalog` service) and a real ES256 key pair from `pso security:keys --generate`. Each scenario below started the compiled orchestrator with one setting changed. The good configuration:

```bash
PSO_JWT_ISSUER=https://lab.local PSO_JWT_AUDIENCE=lab-api \
PSO_JWT_PUBLIC_KEY_FILE=keys/<kid>.public.pem PSO_JWT_ALGORITHMS=ES256 \
PSO_LOG_FORMAT=json node dist/main.js
```

```json evidence="verified"
{"ts":"2026-11-08T16:54:40.066Z","level":"info","msg":"orchestrator listening","component":"http","host":"127.0.0.1","port":3100,"routes":3,"modules":1}
```

(The port was 3100 in the run. Logs are JSON because `PSO_LOG_FORMAT=json` was set; in a terminal you see the pretty, coloured form of the same events: [logging](/devops/logging).)

## How to read a start-up failure

| Field | Meaning |
|---|---|
| `"level":"error"` | the process is about to exit |
| `"code"` | a stable code; search the docs and your logs for it |
| `"detail"` or `"error"` | the specific reason |
| `"diagnostics"` | the codes collected for this failure |
| `"nothing was started"` / `"no route is active"` | nothing is listening: a refusal, not a degraded start |

## 1. A guarded route and no JWT settings (`PSO_SEC_MISSING`)

Reproduced in [Validation errors, one by one](/reference/diagnostics-catalog) (section 11): without `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` and a key source, an orchestrator that has a route using the `jwt` guard does not start, in development or in production. A fresh orchestrator with no guarded route starts without them. Check ahead of time with `pso security:validate`.

## 2. A symmetric algorithm (`PSO_SEC_ALGORITHM`)

`PSO_JWT_ALGORITHMS=HS256`:

```json evidence="verified"
{"ts":"2026-11-08T16:54:40.493Z","level":"error","msg":"security initialization failed","code":"PSO_SEC_ALGORITHM","detail":"unsupported algorithm \"HS256\": only asymmetric signature algorithms are accepted (RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512, EdDSA); HS* and \"none\" are refused"}
{"ts":"2026-11-08T16:54:40.493Z","level":"error","msg":"startup failed","error":"security initialization failed; the application did not start and no route is active","diagnostics":["PSO_SEC_ALGORITHM"]}
```

**Why.** A shared secret can both verify and forge tokens, so every service that verifies would also be able to mint them. Asymmetric keys let services verify with a public key only. `none` and the `HS*` family are the algorithms behind the classic JWT confusion attacks. **Fix.** Use one of the listed algorithms. **Prevention.** `pso security:keys --generate` produces ES256 by default.

## 3. A key file that does not exist (`PSO_SEC_PEM_PATH`)

```json evidence="verified"
{"ts":"2026-11-08T16:54:40.714Z","level":"error","msg":"security initialization failed","code":"PSO_SEC_PEM_PATH","detail":"public key file not found or not a regular file: <workspace>\\keys\\nope.pem"}
{"ts":"2026-11-08T16:54:40.714Z","level":"error","msg":"startup failed","error":"security initialization failed; the application did not start and no route is active","diagnostics":["PSO_SEC_PEM_PATH"]}
```

**Cause.** The path is wrong, or it is relative to a different directory than you think. A relative path is resolved from the **process's working directory**, which differs between `npm run dev` in `gateway/` and `pso dev` or a container. **Fix.** Use the path printed in `detail`; prefer an absolute path in deployments. **Prevention.** Keep the value in one place (`gateway/.env`) and run `pso security:validate`.

## 4. A JWKS URL over plain http (`PSO_SEC_JWKS_INSECURE`)

`PSO_JWT_JWKS_URI=http://idp.example.com/jwks.json`:

```json evidence="verified"
{"ts":"2026-11-08T16:54:40.940Z","level":"error","msg":"security initialization failed","code":"PSO_SEC_JWKS_INSECURE","detail":"the JWKS endpoint must use https"}
{"ts":"2026-11-08T16:54:40.940Z","level":"error","msg":"startup failed","error":"security initialization failed; the application did not start and no route is active","diagnostics":["PSO_SEC_JWKS_INSECURE"]}
```

**Why.** Whoever can alter that response chooses which keys your service trusts. **Fix.** Use `https`. Plain `http` is accepted only for loopback in development (the CRUD tutorial serves `keys/jwks.json` on `127.0.0.1`: [Build a CRUD API](/architecture/manual-crud-0-1#12-give-both-services-a-way-to-verify-tokens)).

## 5. Production and a remote plaintext upstream

`PSO_ENV=production` with `PSO_UPSTREAM_CATALOG=catalog.internal:8081`:

```json evidence="verified"
{"ts":"2026-11-08T16:54:40.273Z","level":"error","msg":"startup failed","error":"invalid upstream security configuration:\n - catalog: production requires TLS to non-loopback upstreams (set the TLS settings, or allowPlaintext: true to accept the risk explicitly); catalog.internal is reached over plain HTTP: set PSO_UPSTREAM_CATALOG_TLS=true (with PSO_UPSTREAM_CATALOG_TLS_CA_FILE for a private CA), or, for this upstream only, PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT=true\nnothing was started","diagnostics":[]}
```

**Fix.** Configure TLS for the upstream ([service identity and mTLS](/security/service-identity)). `allowPlaintext: true` exists for networks where something else (a service mesh, for example) encrypts the hop; setting it only to silence this error trades a visible failure for an invisible exposure. In development the same address starts, because the rule is for production.

## 6. A value out of range (`PSO_CONFIG_INVALID_VALUE`)

`PSO_CFG_http__rateLimit__perMinute=-5`:

```json evidence="verified"
{"ts":"2026-11-08T16:54:41.157Z","level":"error","msg":"security initialization failed","code":"PSO_CONFIG_INVALID_VALUE","detail":"\"http.rateLimit.perMinute\" must be >= 0"}
{"ts":"2026-11-08T16:54:41.157Z","level":"error","msg":"startup failed","error":"security initialization failed; the application did not start and no route is active","diagnostics":["PSO_CONFIG_INVALID_VALUE"]}
```

(The message says "security initialization" because rate limiting is part of the security configuration.) **Fix.** Use a value the message allows. `PSO_CFG_<path with __>` is the environment form of any setting in `pso.config.json` ([configuration](/concepts/configuration)).

## 7. A log level that does not exist

`PSO_LOG_LEVEL=loud`:

```json evidence="verified"
{"ts":"2026-11-08T16:54:41.363Z","level":"error","msg":"startup failed","error":"PSO_LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal, silent (got \"loud\")\nnothing was started","diagnostics":[]}
```

**Fix.** Use one of the listed levels. The orchestrator refuses rather than guessing, so a typo cannot silently turn logging off.

## 8. An invalid port

`PORT=abc`:

```json evidence="verified"
{"ts":"2026-11-08T16:54:41.596Z","level":"error","msg":"startup failed","error":"options.port should be >= 0 and < 65536. Received type number (NaN)."}
```

The message comes from Node's HTTP server, so it does not name the variable. **Fix.** Set `PORT` to a number from 0 to 65535 (`pso.workspace.json` holds the port `pso dev` passes).

## A misspelled setting is not a start-up failure: `pso config:validate`

Outside production a typo in `pso.config.json` is **not** a refusal: the orchestrator logs `unknown configuration key ignored` (with the closest known key) on every start and carries on, and `pso config:validate` reports it ahead of time (here `perMinuet` instead of `perMinute`):

```text evidence="verified"
WARNING PSO_CONFIG_UNKNOWN_KEY gateway/pso.config.json: Unknown configuration key "http.rateLimit.perMinuet"
        hint: Did you mean "http.rateLimit.perMinute"? Check the spelling; known keys: server.host, server.port, server.maxBodyBytes, server.upstreamTimeoutMs, http.limits.maxBodyBytes, ...
OK
```

(The hint lists every known key; it is shortened here.) Note the last line: `OK`. In development a warning does not fail the command. Under **strict validation** the same key is an `ERROR` and the command ends with `FAILED` (exit code 1): strict is on with `--strict`, with `--env production` and with `PSO_CONFIG_STRICT=true`. Run `pso config:validate --strict` in CI.

In the `production` environment the orchestrator itself refuses to start on an unknown key (set `PSO_CONFIG_STRICT=false` to keep the warning-only behaviour deliberately):

```text evidence="expected"
invalid configuration:
 - Unknown configuration key "http.rateLimit.perMinuet" in pso.config.json (Did you mean "http.rateLimit.perMinute"?)
 - strict configuration validation is on (production, or PSO_CONFIG_STRICT=true): fix or remove the keys above; application settings belong under "app."
nothing was started
```

## The port is already in use

The listener is bound last. When the address is taken the orchestrator releases everything it had already started (Dispatch consumers, Channels, the rate-limit connection, security key providers) and exits with one diagnostic, code `PSO_HTTP_LISTEN`:

```text evidence="expected"
cannot listen on 127.0.0.1:3000: the address is already in use
nothing was started
```

The same release happens for every start-up failure after something was acquired; the log line `start-up failed: acquired resources were released` lists what was released.

## A checklist for a refused start

1. Read the `code` first, then `detail` or `error`.
2. `pso security:validate` for anything starting with `PSO_SEC_`: it finds missing and invalid security settings without starting anything.
3. `pso config:validate` for settings.
4. Remember that relative paths depend on the working directory.
5. After the fix, start again and look for `orchestrator listening`.

## Common mistakes

- Starting the process, seeing no output in the browser, and not reading the log: a refusal prints one line and exits.
- Setting `allowPlaintext` or lowering a limit to make the error go away.
- Putting secrets in `pso.config.json`: use environment references ([secrets](/security/secrets)).
- Trusting that a typo in a setting name will be reported at start-up. It will not.

## Next steps

- [Validation errors, one by one](/reference/diagnostics-catalog)
- [Security configuration](/security/security-configuration)
- [TLS and mutual TLS](/security/tls-and-mtls)
- [Configuration resolution](/concepts/configuration)
