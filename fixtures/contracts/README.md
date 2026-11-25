# fixtures/contracts/

Language-neutral contract data. The TypeScript implementation and the Java starters read the **same files** and must reach the same verdict, so these stay in the repository and are shared, not copied.

| Directory | Contract | TypeScript test | Java test |
|---|---|---|---|
| `jwt/` | pre-signed JWT cases (throwaway key, public JWK only); regenerate with `node scripts/gen-jwt-fixtures.mjs` | `packages/security/test/conformance.test.ts` | `JwtConformanceTests` |
| `problem/` | the RFC 9457 error catalog | `packages/cli/test/problem.test.ts` | `ProblemsTests`, `ProblemTests` |
| `ratelimit/` | token-bucket decisions | `packages/cli/test/ratelimit.test.ts` | `RateLimitContractTests` |
| `conformance/` | authorization, correlation id, liveness | `packages/cli/test/conformance-http.test.ts` | `AuthorizationConformanceTests`, `ConformanceHttpTests` |
| `dispatch/` | event envelopes, schemas, signatures | `packages/dispatch/test/core.test.ts`, `trust.test.ts` | `pso-dispatch-test` |
| `channels/` | channel envelope | `packages/channels/test/fixture.test.ts` | `ChannelsPublishingTests` |

Java tests resolve these paths relative to their module directory (`../../fixtures/contracts/<name>/...`).
