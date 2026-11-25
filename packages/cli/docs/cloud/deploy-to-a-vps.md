---
title: Deploy a real PSO application to a Linux VPS
description: A practical, end-to-end guide - prepare the server, enroll your machine, store secrets, deploy a generated PSO gateway and Spring Boot services with PostgreSQL as systemd units behind nginx, update them independently, roll back and recover.
order: 16
status: partial
keywords: [vps, linux, systemd, nginx, postgresql, spring boot, gateway, deploy, studio, enrollment, existing server]
related: [cloud/systemd-runtime, cloud/connect-a-server, cloud/release-signing, cloud/external-validation, tutorials/crud-api]
---
> [!STATUS]
> The steps below were **exercised on a disposable Debian 12 container with systemd, PostgreSQL 15, Java 21, Node.js 24 and nginx, reached over real SSH** (`packages/deploy/test/e2e-real-pso.test.ts`). They have **not** been run on an external cloud server. Where a step needs something your provider controls (DNS, TLS certificates, firewall), PSO documents it but does not do it.

The example is the workspace of the [Build a CRUD API](/tutorials/crud-api) tutorial: a Node.js **gateway** (the orchestrator), two Spring Boot services **catalog** and **inventory**, each with its own PostgreSQL database, and the tutorial's ES256 JWKS publisher. It was created with `pso create workspace`, `pso create service ... --db postgres`, `pso create orchestrator` and `pso security:keys --generate`; nothing in the framework was changed to deploy it.

## 1. What the server needs

| Need | Detail |
|---|---|
| Linux with systemd | Debian 12 / Ubuntu 22.04+ were used. Without systemd the default supervisor still works, but does not survive a reboot |
| An SSH account for deployment | **Not root**, for example `deploy`. Key login; `PasswordAuthentication` may stay off |
| Node.js ≥ 24 | needed by the agent itself and by Node services. PSO never installs packages |
| Java 21 | for generated Spring services (their `pom.xml` says 21) |
| nginx | blue-green and rolling need it. An existing installation is adopted, not replaced |
| PostgreSQL ≥ 14 | one role and database per service. PSO does not provision databases |
| 1 GB RAM free per JVM you run twice during a switch | blue-green runs old and new side by side |
| Network | inbound SSH from you; inbound 80/443 from clients (yours to open). **PSO opens no port and changes no firewall** |

## 2. Prepare the server once (administrator)

PSO prints what it needs instead of doing it. After enrolling (step 3) run:

```bash
pso environment:plan production
```

It lists each step with its status and prints one reviewable script. Typical content: the PSO-owned nginx directory `/etc/nginx/pso.d` owned by `deploy`, a sudo rule that allows exactly `nginx -t` and `nginx -s reload` and nothing else, and `loginctl enable-linger deploy`. An administrator reads it and runs it as root. Add `include /etc/nginx/pso.d/*.conf;` inside the `http { }` block once (PSO never edits `nginx.conf`).

Create the databases yourself, with a password you keep out of the repository:

```bash
sudo -u postgres psql -c "CREATE ROLE catalog LOGIN PASSWORD '...'" -c "CREATE DATABASE catalog OWNER catalog"
```

## 3. Connect and enroll your machine

```bash
pso connection:add production --host 203.0.113.10 --user deploy --auth key --key ~/.ssh/id_ed25519
pso agent:install production --mode protected --environment production --yes
pso agent:enroll production
```

`connection:add` shows the server's SSH host-key fingerprint and waits for you to confirm it (compare it with your provider's console). `--auth agent` uses a key held by your `ssh-agent` (PSO never reads it); `--auth key` with a passphrase asks for the passphrase on a hidden prompt and keeps it in the credential store. `agent:install` copies one bundled file, starts nothing and prints a single-use enrollment token; `agent:enroll` reads it from a hidden prompt, generates **your** client key (Ed25519, in your protected credential store) and enrolls its **public** half. Your permanent secret never leaves your machine, and the server never holds anything that lets someone else become you. See [Agent and enrollment](/cloud/agent-and-enrollment).

Production management stays **disabled** unless the host administrator chose `--mode`. With `protected`, deployments need an approval.

## 4. Secrets

```bash
pso environment:secret production catalog-db-password        # value from a hidden prompt or standard input
```

The value is stored on the server (mode 600), reaches the service as an environment variable, and never appears in a declaration, plan, log, argument list or audit entry.

## 5. Declare and deploy

One `deploy/production.deployment.pso.ts` per application (the gateway, each Spring service, the JWKS publisher). The Spring service, abridged:

```ts
export default defineDeployment({
  name: "shop-catalog", environment: "production",
  connection: { provider: "ssh", credentials: "production" },
  source: { provider: "artifact", path: "artifacts/catalog.tgz" },     // the jar you built, or a git source
  runtime: { supervisor: "systemd", restart: "on-failure" },
  service: {
    name: "catalog", runtime: "java", start: ["java", "-Xmx256m", "-jar", "app.jar"],
    health: { readyPath: "/actuator/health", timeoutSeconds: 150 }, shutdownGraceSeconds: 20,
    internalPort: 8101,                       // the stable address the gateway's workspace file points at
    env: { SPRING_PROFILES_ACTIVE: "staging", DB_URL: "jdbc:postgresql://127.0.0.1:5432/catalog", DB_USER: "catalog", PSO_JWT_ISSUER: "https://idp.example.com", PSO_JWT_AUDIENCE: "shop-api", PSO_JWT_JWKS_URI: "https://idp.example.com/.well-known/jwks.json" },
    secrets: { DB_PASSWORD: "catalog-db-password" },
    workload: { selfMigrates: true },        // Flyway runs at start: see Workloads and rollback safety
  },
  migrations: { mode: "expand-contract" },
  strategy: { type: "blue-green", proxy: "nginx", rollback: true, drainSeconds: 3 },
  proxy: { nginx: { domains: ["catalog.internal"], listen: { http: 8080 } } },
});
```

Declarations hold **references**, never credentials; a value that looks like a secret is refused. Then:

```bash
pso pipeline:validate production
pso release:plan production
pso release:deploy production --yes
```

The plan shows the commit or checksum, the strategy, the resources, who vouches for the release, what is checked, what is switched off, what database changes mean for rollback, and what is enforced no matter what. Nothing changes on the server until you approve it.

For the gateway, point `PSO_WORKSPACE` at the `pso.workspace.json` packaged with it; the ports in that file for `catalog` and `inventory` are their `internalPort` values, so the gateway always reaches whichever release is active.

## 6. Use the application

Through the gateway with a token from your identity provider (the tutorial's `dev-token.mjs` only for development). The services also validate the token themselves against the JWKS, so they do not trust the network. In the exercised run an anonymous request got `401`, a token without the scope `403`, and a valid one `201` with the row in PostgreSQL.

## 7. Update one thing at a time

Deploy only the service that changed. In the exercised run, replacing the catalog (with an additive migration) under authenticated traffic restarted **only** the catalog (the other services kept their process ids) and no request failed; replacing the gateway left both Spring services running. A candidate that the framework's own startup validation refused (an invalid JWT algorithm) never received traffic and the active release kept serving.

## 8. Roll back and recover

```bash
pso release:rollback production --yes
pso release:status production
pso release:recover production --yes        # after an interrupted deployment
```

Rollback restores the previous **code**; it does not undo database changes: the plan said so before you deployed. After a server restart, with lingering on, PostgreSQL and the **active** releases come back by themselves. See [Rollback and recovery](/cloud/rollback-and-recovery).

## 9. From Studio

`pso studio --remote` opens the same operations: connections, enrollment, policy, plans, deployment progress, logs, rollback, recovery, the audit trail and signers. Studio runs on loopback only and every change goes through the same calls and the same server policy as the CLI.

## 10. An existing VPS

Adopting a server that already runs things is the normal case. PSO reads before it writes: `pso environment:inspect production` reports what is listening, which nginx virtual hosts exist and whether `nginx -t` passes. It writes only files named `pso-<app>.conf` that carry its marker, never edits another virtual host, and refuses a plan that would collide on a name or port. Services it did not start are never signalled.
