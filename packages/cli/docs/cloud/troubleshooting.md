---
title: Troubleshooting cloud operations
description: The refusals and failures you can meet, what each one means, and what to do, from SSH and enrollment to plans, deployments and recovery.
order: 13
status: implemented
keywords: [troubleshooting, errors, plan stale, locked, needs-operator, host key, nginx, enrollment]
related: [cloud/overview, cloud/connect-a-server, cloud/rollback-and-recovery, cloud/nginx-and-existing-infrastructure]
---
Almost every failure in this area is a deliberate refusal that names its reason. Find it below.

## Connecting

| You see | Meaning | Do |
|---|---|---|
| `Host key verification failed` | the server's SSH key differs from the one you pinned | confirm with your provider; if the server was rebuilt, `connection:remove` and add it again |
| `AGENT IDENTITY CHANGED` | another agent key answers than the pinned one; nothing was sent | same as above; the agent identity is regenerated only by a reinstall |
| `No protected credential store is available` | no OS keyring, and no explicit `encrypted-file` configuration | install `libsecret-tools` or set `PSO_CREDENTIAL_PROVIDER=encrypted-file` plus a passphrase or key file |
| `the agent is not provisioned` | `agent:install` has not run | run it with `--mode` and `--environment` |
| `remote management is DISABLED` | the server's mode is `disabled` | a host administrator runs `pso-agent set-mode` on the server |
| `Cannot find module .../pso-agent.mjs` | the agent was not installed | `pso agent:install` |

## Enrolling and permissions

`enrollment refused` covers a wrong, expired and used token alike, on purpose. Create a new one (`pso environment:access <env> --invite <role>`). `RATE_LIMITED` means too many failures from your address or key; wait for the time shown. `FORBIDDEN ... needs the role "deployer"` means your client has a lower role; ask an administrator.

## Planning

A plan with blockers lists each reason. Common ones:

- *this server is the production environment but the declaration targets staging*: use the right declaration for the server.
- *nginx is not installed* / *nginx -t fails* / *not writable*: see [nginx and existing infrastructure](/cloud/nginx-and-existing-infrastructure); PSO does not install packages.
- *not enough free memory or disk*: the strategy needs room for a second release (blue-green) or the plan blocks.
- *another deployment is in progress (deployment lock held)*: wait, or recover it (below).
- *the server policy does not allow the "blue-green" strategy*: the server's policy overrides the project.

### Signatures and runtime

- *this environment requires releases signed by a trusted signer*: sign the release (`pso release:sign`) and pass `--signed <file>`; see [release signing](/cloud/release-signing).
- *untrusted-signer*, *revoked-signer*, *expired-signer*, *signer-not-allowed-for-app*: the server's trust store decides; a superadministrator adds a signer with `pso trust:add`. A revoked key is never accepted again.
- *manifest-mismatch*: the signature is genuine but names another commit or checksum than the one the server resolved; sign again after the branch moved.
- *not newer than the last deployed signed release*: raise `--sequence`; to return to an older release use `release:rollback`.
- *systemd is requested but unusable*: the user's systemd manager is not reachable or the server policy does not allow it; the message says which, and lingering is an administrator step (`loginctl enable-linger <user>`).
- *scheduled jobs without leader election* / *applies its own migrations* (blockers): see [workloads](/cloud/workloads-and-rollback-safety).
- HTTP `429` through a generated gateway during a load test: its rate limiter is working; lower the request rate or raise `PSO_RATE_LIMIT_PER_MINUTE` for that service on purpose.

## Deploying

| State or error | Meaning | Do |
|---|---|---|
| `CANDIDATE_NOT_READY` | the new release crashed or never answered its readiness path | read `pso release:logs <env> --deployment <id>`; the active release was never touched |
| `PROXY_REJECTED` | nginx rejected the new configuration | the previous configuration is still active; read the logged `nginx -t` output |
| `ACTIVE_NOT_VERIFIED` | after switching, probes through the proxy did not reach the new release | the previous proxy configuration was restored while the old release still ran |
| `PLAN_STALE` | the branch, the active release or the policy changed after planning | plan again; the newest commit is never deployed implicitly |
| `INTERRUPTED` | the worker on the server disappeared | `pso release:recover <env> --yes` |
| `needs-operator` | recovery found contradictory evidence and changed nothing | inspect with `release:status`, then `release:rollback` or deploy again |

## The application is deployed but I cannot open it

1. `pso release:url <app> --verify` shows each layer separately. If the process, local health and proxy on the server are verified but this machine times out, the server is healthy and something on the path (a cloud network security group, a firewall, your own network) is dropping the traffic. That is a hypothesis until the owner of the network confirms it.
2. `pso release:url <app> --verify --tunnel --ca-file <ca.pem>` reaches the application through the authenticated SSH connection with TLS verified: it proves the application works while the public path is closed.
3. Open the rule in your cloud provider's console (inbound TCP 443 from your public IP only) yourself; PSO never changes cloud settings.

## Open the application in a browser

A browser needs two things: a network path to the server and a certificate it trusts. An IP-based environment has no domain, so its certificate comes from a private certificate authority (CA) that no browser knows.

**Trust the CA (public certificate only).** Give the browser the CA *certificate* (`ca.pem`, the public part). Never copy the CA's private key: it is not needed and must not leave the machine that created it.

```bash
# Windows (current user only; no administrator needed). The CA certificate is public.
certutil -user -addstore Root path\to\ca.pem
# macOS
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db path/to/ca.pem
# Linux (Chrome and Chromium use the user database; Firefox has its own store: Settings, Certificates, Authorities, Import)
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n pso-validation-ca -i path/to/ca.pem
```

Check the certificate you are trusting before you trust it: compare the SHA-256 fingerprint the owner gives you (`openssl x509 -in ca.pem -noout -fingerprint -sha256`) with the one in the file. The server certificate must name the address you type (a subject alternative name of type IP): `pso release:url <app> --verify --ca-file ca.pem` checks the chain and the name. Remove the CA from the trust store when the validation ends. TLS verification is never turned off to make a page open.

**While the public port is closed, use the tunnel.** From a machine that holds the connection:

```bash
node scenarios/tunnel.mjs          # in the fixture: https://127.0.0.1:18443 -> the server's HTTPS port, authenticated by SSH, loopback only
```

Then open `https://127.0.0.1:18443/` (the certificate also names 127.0.0.1). This is **temporary private access**, not public access: it exists only while the command runs and only on your machine. Whether the public address works is a different fact: check it with `pso release:url <app> --verify`.

## Verification you can run yourself

```bash
pso connection:test prod
pso environment:inspect production
pso release:status production
pso release:audit production --verify
```

```text evidence="expected"
audit chain intact: 214 entries, head 7f3a91c04b22d8e1…
```

## What can go wrong when troubleshooting

Do not delete lock directories or edit state files by hand: recovery exists because a stale lock may protect a half-finished release. Do not copy a token or log into a ticket without checking it: PSO masks what it knows, and a secret an application prints in an unusual form can survive in that application's own log. If a server was changed outside PSO (a manual `nginx` edit of a managed file), the next deployment will overwrite it; managed files say so in their first line.

## Lessons from the first external validation

- **Several applications in one environment.** Every deployment declaration has a unique `name`; commands and Studio address a deployment by that name (`pso release:plan shop-catalog`), because the environment name (`production`) is shared and would be ambiguous. The typed confirmation still asks for the **environment** name (the server also accepts the application name).
- **A new connection must pin the agent first.** `pso connection:test <name> --pin-agent <fingerprint>` verifies the agent's key by challenge-response and **saves** the pin (it did not before 2026-11-15); only then does `pso agent:enroll` work.
- **After a server restart an application did not come back.** Boot persistence belongs to the *active* release's units. Stopping a service disables it on purpose; starting or restarting it again re-enables it (fixed after the first reboot test: a service restart used to leave it disabled). `loginctl show-user <user> -p Linger` must say `yes`.
- **A JVM stopped for a replacement shows as `failed` in systemd.** It exits with status 143 on SIGTERM; PSO now declares 143 a success so a cleanly replaced release is not reported as a failure.
- **HTTP 301 on the public port, then a failed verification.** When TLS is configured the public HTTP port only redirects; the agent verifies the release through nginx's loopback listener and checks that the redirect exists.
- **A request reset exactly at a traffic switch.** nginx reloads gracefully, but a client that reuses an idle persistent connection can still be reset at that instant (one request in about 100 to 360 in the measured runs; none with one connection per request). Clients should retry idempotent requests. PSO does not claim zero downtime.
- **Packing a directory artifact on Windows** failed when `tar` was Git's GNU tar and the output path was absolute (`C:\...`): fixed. A packaged orchestrator must include `pso.config.json`; there is no public packaging command yet, so omitting it only shows at start-up.
- **The server audit is dominated by `session.open`.** Every Studio or CLI call opens a session and the last 200 entries can be mostly those; filter by event when looking for deployments.
