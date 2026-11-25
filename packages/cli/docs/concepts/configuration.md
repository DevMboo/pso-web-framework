---
title: Configuration resolution
description: Six layers with documented precedence, a typed schema and secrets only as references - how to inspect the effective value of every setting and where each value came from.
order: 10
keywords: [config, precedence, env, secret, redaction, config:show, config:validate]
related: [reference/config, devops/environment-configuration, reference/environment-variables, decisions/dev-or-production-config]
---
Precedence, lowest to highest:

1. framework defaults
2. workspace (`"config"` in `pso.workspace.json`)
3. service (`<service>/pso.config.json`)
4. environment file (`pso.config.<env>.json`, where `<env>` is development, test, staging or production)
5. environment variables such as `PSO_CFG_server__port=9000` (`__` separates path segments)
6. explicit `--set key.path=value`

A later layer overrides an earlier one, key by key. The short names documented in the [variables reference](/reference/environment-variables) (`MAX_BODY_BYTES`, `PSO_LOG_LEVEL`, ...) are aliases of canonical keys and win over their `PSO_CFG_` form.

## See where a value comes from

```bash
pso config:list
pso config:show --service catalog
pso config:validate
```

`config:show` prints every effective value with its origin. An excerpt of the real output for a new Spring service (the command prints many more keys, among them every `dispatch.*` default):

```text evidence="verified"
# catalog (development)
dispatch.enabled                   false                <- defaults
dispatch.provider                  "none"               <- defaults
logging.level                      "info"               <- defaults
security.authentication.algorithms ["ES256","RS256"]    <- defaults
security.authorization.defaultPolicy "authenticated"      <- defaults
server.host                        "127.0.0.1"          <- defaults
server.maxBodyBytes                1048576              <- defaults
server.port                        8081                 <- workspace
server.upstreamTimeoutMs           5000                 <- defaults
```

Now override one thing per layer and watch the origin column change:

```bash
pso config:show --service catalog --env production --set logging.level=debug
```

```text evidence="verified"
# catalog (production)
logging.level                      "debug"              <- cli
server.port                        8081                 <- workspace
```
*(An excerpt: the header names the environment, and the last column names the layer that supplied the final value: `cli` for `--set`, `workspace` for the port. A `PSO_CFG_` variable shows as `environment-variables`.)*

## Secrets

Keys that look like secrets (`password`, `token`, `secret`, `apiKey`, ...) must be **references**, never literals:

```json title="orchestrators/gateway/pso.config.json" evidence="expected"
{ "security": { "jwt": { "publicKeyFile": "${env:PSO_PUBKEY}" } } }
```

A literal is `PSO_CONFIG_PLAINTEXT_SECRET`. `config:show` prints `***REDACTED***` for secret-looking keys and shows references as references.

> [!NOTE]
> The redaction goes by the **name** of the key. In the real output of `config:show --service catalog`, `security.authentication.maxTokenBytes` (a number, not a secret) is printed as `"***REDACTED***"` because its name contains `Token`. Redaction errs on the side of hiding; it is not a sign that a secret is configured.

Wrong types are errors in every mode. Unknown keys are **warnings** in development and **errors under strict validation**. Strict validation is on in the `production` environment, with `pso config:validate --strict`, and with `PSO_CONFIG_STRICT=true` (use it in CI); `PSO_CONFIG_STRICT=false` switches it off explicitly. The orchestrator applies the same policy when it starts: in production an unknown key in `pso.config.json`, `pso.config.<env>.json` or a `PSO_CFG_*` variable stops start-up and names the key, its file and the closest known key; elsewhere it is logged as `unknown configuration key ignored` on every start. Values are never printed. Keys under `app.` belong to your application and are never judged; `channels.*` and `http.upstreams.*` are validated by the packages that own them. All keys are in the [configuration reference](/reference/config).

> [!NOTE]
> The orchestrator's JWT guard reads `PSO_JWT_*` environment variables at runtime. The `security.jwt.*` configuration keys feed the static checks (`pso security:check`); set both consistently.

## Variations

| You want | Do |
|---|---|
| the same value everywhere | `pso.config.json` of the service |
| a different value in production | `pso.config.production.json`, or an environment variable set by the platform |
| to change one value for one command | `--set key.path=value` |
| a secret | an environment variable, referenced as `${env:NAME}` |
| to see what production would use | `pso config:show --service <name> --env production` |

## Common mistakes

- Writing a password or token literal in a file (`PSO_CONFIG_PLAINTEXT_SECRET`).
- Expecting an environment variable for a key to override `--set` (it does not: `--set` is last).
- Misspelling a key and not noticing: run `pso config:validate --strict` in CI (a typo then fails the pipeline); production start-up refuses it as well.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| start-up fails with `PSO_CONFIG_INVALID_VALUE` | a value is out of range, for example `"http.rateLimit.perMinute" must be >= 0` | the `detail` field | use an allowed value |
| a setting has no effect | its name is misspelled; outside production an unknown key is only warned about | `pso config:validate` prints `PSO_CONFIG_UNKNOWN_KEY` with a `Did you mean` suggestion; the orchestrator logs `unknown configuration key ignored` at start-up | fix the spelling |
| start-up fails with `Unknown configuration key "..." in pso.config.json` | production validates configuration strictly | the message names the key, the file and the closest known key | fix the key, move application settings under `app.`, or set `PSO_CONFIG_STRICT=false` deliberately |
| start-up fails with `PSO_LOG_LEVEL must be one of: ...` | an unknown log level | the message lists the valid ones | use one of them |
| start-up fails with "options.port should be >= 0 and < 65536" | `PORT` is not a number | `echo $PORT` | set a number |
| a value from the file is overridden | an environment variable has higher precedence | `pso config:show` marks each value's layer | change it where it is set |

The first four rows were reproduced: [Why the orchestrator refuses to start](/reference/startup-failures). `pso config:validate` exits 0 on a warning, so a pipeline must look for `WARNING` itself.

## Next steps

- [Environment configuration](/devops/environment-configuration)
- [Development or production configuration?](/decisions/dev-or-production-config)
