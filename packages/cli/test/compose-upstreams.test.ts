import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUpstreams, loadUpstreamPolicy, checkProductionTransport } from "@pso/http";
import { pso, tmp } from "./helpers.ts";

/**
 * The generated Docker Compose deployment and the production upstream policy (DEP-01). The defect: the compose file gave the
 * orchestrator `PSO_UPSTREAM_CATALOG=catalog:8081` and nothing else, and the orchestrator image runs in production mode, where a
 * plain-HTTP upstream on another host is refused: the generated gateway never started.
 *
 * The policy is unchanged. The generated file states the transport of every declared upstream, one upstream at a time; these
 * tests take the environment the compose file gives the orchestrator and run the real start-up rule on it. Since CFG-01 the default
 * transport is TLS (tls-cli.test.ts); the explicit plain-HTTP mode, `--transport plaintext`, is what is exercised here.
 */
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

async function workspace(): Promise<string> {
  const base = tmp("pso-compose-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "w")).code, 0);
  const root = join(base, "w");
  assert.equal((await pso(root, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "service", "catalog", "--structure", "legacy", "--port", "8081")).code, 0);
  assert.equal((await pso(root, "create", "service", "billing-api", "--structure", "legacy", "--port", "8082")).code, 0);
  return root;
}
/** The environment block of one service of the generated file, with ${VAR:-default} resolved against `dotenv` as Compose does. */
function environmentOf(composeFile: string, service: string, dotenv: Record<string, string> = {}): Record<string, string> {
  const block = new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  \\S|\\nnetworks:)`).exec(composeFile)?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const m of block.matchAll(/^ {6}([A-Z0-9_]+): "?([^"\n]*)"?$/gm)) env[m[1]!] = m[2]!.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g, (_, k: string, d: string) => dotenv[k] ?? d);
  return env;
}
/** The orchestrator's own start-up rule, on that environment, in production. */
function startupProblems(env: Record<string, string>): string[] {
  const full = { ...env, NODE_ENV: "production" };
  const problems: string[] = [];
  for (const [name, t] of loadUpstreams(undefined, full)) checkProductionTransport(name, t.host, loadUpstreamPolicy(name, full, undefined, problems), full, problems);
  return problems;
}

test("--transport plaintext: the generated compose file authorizes plain HTTP per upstream, explicitly, and the orchestrator starts with it in production", async () => {
  const root = await workspace();
  const init = await pso(root, "docker:init", "--transport", "plaintext");
  assert.equal(init.code, 0, init.err);
  const dc = readFileSync(join(root, "docker-compose.yml"), "utf8").replaceAll("\r\n", "\n");
  const env = environmentOf(dc, "gw");
  // one address and one decision per declared upstream, generated from the workspace (nothing is hardcoded, nothing is a wildcard)
  assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("PSO_UPSTREAM_"))), {
    PSO_UPSTREAM_CATALOG: "catalog:8081", PSO_UPSTREAM_CATALOG_PREFIX: "/catalog", PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT: "true",
    PSO_UPSTREAM_BILLING_API: "billing-api:8082", PSO_UPSTREAM_BILLING_API_PREFIX: "/billing-api", PSO_UPSTREAM_BILLING_API_ALLOW_PLAINTEXT: "true",
  });
  assert.doesNotMatch(dc, /PSO_UPSTREAM_ALLOW_PLAINTEXT|ALLOW_PLAINTEXT: "?\*|PSO_ENV: "?development|NODE_ENV/, "no global switch and no downgrade of the environment");
  for (const s of ["catalog", "billing-api"]) assert.equal(Object.keys(environmentOf(dc, s)).some((k) => k.startsWith("PSO_UPSTREAM_")), false, "only the orchestrator carries upstream settings");
  assert.deepEqual(startupProblems(env), [], "the production rule accepts the generated configuration as generated");
  // the choice is described as what it is, where the operator reads it
  assert.match(dc, /That is a deployment choice, not encryption/);
  assert.match(dc, /does not forward the caller's bearer token over a plaintext hop/);
  assert.match(init.out, /NOTE {7}gw -> catalog: plain HTTP on the private compose network, authorized for this upstream only \(PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT\)\. Not encrypted/);
  assert.match(init.out, /NOTE {7}gw -> billing-api: .*PSO_UPSTREAM_BILLING_API_ALLOW_PLAINTEXT/);
  const example = readFileSync(join(root, ".env.example"), "utf8");
  for (const v of ["# PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT=true", "# PSO_UPSTREAM_BILLING_API_ALLOW_PLAINTEXT=true", "# PSO_SHUTDOWN_GRACE_MS=5000", "# PSO_STOP_GRACE_PERIOD=40s"]) assert.ok(example.includes(v), v);
  // Docker must wait longer than the application's own shutdown deadline before it kills a container
  assert.equal((dc.match(/stop_grace_period: "\$\{PSO_STOP_GRACE_PERIOD:-40s\}"/g) ?? []).length, 3);
  assert.equal(env["PSO_SHUTDOWN_GRACE_MS"], "5000");
});

test("the policy still fails closed: withdrawing one authorization stops the start, for that upstream only, and nothing authorizes a host that was not declared", async () => {
  const root = await workspace();
  assert.equal((await pso(root, "docker:init", "--transport", "plaintext")).code, 0);
  const dc = readFileSync(join(root, "docker-compose.yml"), "utf8").replaceAll("\r\n", "\n");
  // .env: PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT=false
  const withdrawn = startupProblems(environmentOf(dc, "gw", { PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT: "false" }));
  assert.equal(withdrawn.length, 1);
  assert.match(withdrawn[0]!, /^catalog: production requires TLS to non-loopback upstreams/);
  assert.match(withdrawn[0]!, /catalog is reached over plain HTTP: set PSO_UPSTREAM_CATALOG_TLS=true \(with PSO_UPSTREAM_CATALOG_TLS_CA_FILE for a private CA\), or, for this upstream only, PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT=true/, "the diagnostic names the upstream, the host and both ways out");
  // only the exact value counts
  for (const sloppy of ["1", "yes", "TRUE", ""]) assert.equal(startupProblems(environmentOf(dc, "gw", { PSO_UPSTREAM_BILLING_API_ALLOW_PLAINTEXT: sloppy })).length, 1, JSON.stringify(sloppy));
  // an upstream that the workspace does not declare gets no authorization from the generated file
  const extra = startupProblems({ ...environmentOf(dc, "gw"), PSO_UPSTREAM_PARTNER: "api.partner.example.com:80" });
  assert.equal(extra.length, 1);
  assert.match(extra[0]!, /^partner: production requires TLS/);
  // TLS for an upstream satisfies the rule without any plaintext authorization
  assert.deepEqual(startupProblems({ ...environmentOf(dc, "gw", { PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT: "false" }), PSO_UPSTREAM_CATALOG_TLS: "true" }), []);
});

test("an upstream for which the project already configures TLS keeps it: no plaintext authorization is generated for it", async () => {
  const root = await workspace();
  const config = { http: { upstreams: { catalog: { tls: { caFile: "/run/secrets/internal-ca.pem", serverName: "catalog.internal" }, forward: "bearer" } } } };
  writeFileSync(join(root, "gw", "pso.config.json"), JSON.stringify(config, null, 2));
  const init = await pso(root, "docker:init", "--transport", "plaintext");
  assert.equal(init.code, 0, init.err);
  const dc = readFileSync(join(root, "docker-compose.yml"), "utf8").replaceAll("\r\n", "\n");
  const env = environmentOf(dc, "gw");
  assert.equal(env["PSO_UPSTREAM_CATALOG"], "catalog:8081");
  assert.equal("PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT" in env, false, "TLS stays TLS");
  assert.match(dc, /# catalog: TLS is configured for this upstream in pso\.config\.json/);
  assert.equal(Object.keys(env).some((k) => k.startsWith("PSO_UPSTREAM_CATALOG_TLS")), false, "the project's own TLS settings are the ones in effect: nothing is generated over them");
  assert.equal(env["PSO_UPSTREAM_BILLING_API_ALLOW_PLAINTEXT"], "true", "the other upstream is unaffected");
  assert.doesNotMatch(init.out, /gw -> catalog: plain HTTP/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "gw", "pso.config.json"), "utf8")), config, "the project's own upstream configuration is not rewritten");
  // the configuration file travels into the image, so the TLS settings are the ones in effect there
  assert.match(readFileSync(join(root, "gw", "Dockerfile"), "utf8"), /COPY --chown=node:node package\.json pso\.config\*\.json \.\//);
  // with the file's policy the rule is satisfied for catalog by TLS, not by an authorization
  const full = { ...env, NODE_ENV: "production" };
  const problems: string[] = [];
  const policy = loadUpstreamPolicy("catalog", full, join(root, "gw"), problems);
  checkProductionTransport("catalog", "catalog", policy, full, problems);
  assert.deepEqual([problems, policy.allowPlaintext, policy.tls?.caFile], [[], false, "/run/secrets/internal-ca.pem"]);
});

test("docker:init points out a main.ts that still carries the fixed 10 s exit timer", async () => {
  const root = await workspace();
  assert.doesNotMatch((await pso(root, "docker:init")).out, /src\/main\.ts ends the process 10 s after a signal/);
  assert.equal((await pso(root, "migrate")).code, 0, "nothing to migrate in a freshly generated orchestrator");
  const main = join(root, "gw", "src", "main.ts");
  writeFileSync(main, readFileSync(main, "utf8").replace(".then((app) => { shutdownOnSignals(app); })", `.then((app) => {
    const shutdown = (sig: string) => { log("info", "shutting down", { sig }); void app.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
    process.on("SIGINT", () => shutdown("SIGINT")); process.on("SIGTERM", () => shutdown("SIGTERM"));
  })`));
  assert.match((await pso(root, "docker:init")).out, /WARNING {4}gw: src\/main\.ts ends the process 10 s after a signal, whatever http\.shutdown\.graceMs says\. Run `pso migrate`/);
});
