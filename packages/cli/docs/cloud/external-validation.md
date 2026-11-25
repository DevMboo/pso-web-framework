---
title: External cloud validation guide
description: What an isolated cloud server must provide, what to run on it in what order, what to record, and how to clean up, so that Cloud Lifecycle and Operations can be validated outside the development machine.
order: 17
status: partial
keywords: [validation, external, cloud, acceptance, checklist, vps, cleanup]
related: [cloud/deploy-to-a-vps, cloud/systemd-runtime, cloud/release-signing, cloud/troubleshooting]
---
> [!STATUS]
> **This validation has not been performed.** Everything marked verified in this section was verified on a disposable container on the development machine. Passing this guide is what would justify calling the SSH deployment workflow validated on a real cloud server; it is not a production-readiness certificate.

Use a **new, isolated, disposable** server that you own and can delete. Do not point this at an existing production server, and do not put production credentials in repository files, prompts, logs or documentation. PSO provisions nothing for you: you create and delete the server.

## Minimum server

| | |
|---|---|
| OS | Debian 12, Ubuntu 22.04 or 24.04 (systemd). Other Linux distributions work with the default supervisor only |
| Size | 2 vCPU, 4 GB RAM, 20 GB disk (blue-green runs two JVMs per Spring service during a switch) |
| Software | Node.js ≥ 24, Java 21, nginx ≥ 1.18, PostgreSQL ≥ 14, git, tar, `sudo` |
| Network | inbound TCP 22 from your address only; 80 and 443 only if you test public access. Nothing else. PSO needs **no** management port |
| Accounts | an administrator account for the one-time preparation, and a **non-root** `deploy` account with key login |

## Order of work

1. **SSH hardening (yours).** Key login for `deploy`, root login off. Record the host-key fingerprint from the provider console.
2. **Connect.** `pso connection:add`, confirm the fingerprint matches, `pso connection:test`. A different fingerprint must fail hard: change it on purpose once and check.
3. **Install and enroll.** `pso agent:install ... --mode protected --yes`, `pso agent:enroll`. Check the token is single use (a second enrollment must be refused) and expires.
4. **Prepare.** `pso environment:plan`, review the script, run it as the administrator. Create the PostgreSQL roles and databases. `pso environment:inspect` must show no blockers.
5. **Secrets.** `pso environment:secret` for each database password. Verify a value never appears in `pso release:plan`, `pso release:logs`, `pso release:audit`, `ps` output or any file under `~/.pso-agent` other than the 600-mode secret.
6. **Initial deployment** of the real applications ([Deploy a real application](/cloud/deploy-to-a-vps)) with `runtime.supervisor: "systemd"`.
7. **Authenticated flow.** Anonymous `401`, wrong scope `403`, valid token creates and reads rows; check the rows in PostgreSQL.
8. **Subsequent release** of one service under light traffic; confirm the others' process ids did not change and no request failed.
9. **Failure.** Deploy a candidate that cannot start; confirm the active release keeps serving and the candidate has no running unit.
10. **Rollback.** `pso release:rollback`; confirm service and callers; note what it did **not** undo (the database).
11. **Recovery.** Kill the deployment worker mid-build; `release:status` must say INTERRUPTED, `release:recover` must act only on the verified state. Disconnect your SSH session during a deployment; it must continue.
12. **Server restart.** Reboot the server. PostgreSQL and the active release must return with no action from you.
13. **Security verification.** Production mode refuses an unenrolled client; a viewer cannot deploy; `pso environment:access --revoke` ends that client's session at once; a revoked signer's release is refused ([Release signing](/cloud/release-signing)); nothing listens on a management port (`ss -ltnp` shows only SSH, nginx, PostgreSQL and your services on loopback).
14. **nginx.** An unrelated virtual host must be byte-identical before and after; a deliberately invalid proxy change must leave the previous configuration serving.
15. **Cleanup.** `pso agent:uninstall production --yes` (keeps applications unless `--purge-applications`), remove `/etc/nginx/pso.d`, the sudoers rule `/etc/sudoers.d/pso-nginx` and the user's linger (`loginctl disable-linger deploy`), drop the databases, then delete the server.

## What to record

For each step: the command, the exit code, the relevant output with secrets removed, and the time. Keep `pso release:audit --verify` output (the hash chain) from the end of the run. Record what **failed**; a failed run is evidence, not an embarrassment.

## What can go wrong, and what this guide cannot establish

Sustained production load, a multi-server topology, provider-specific networking and managed databases, TLS issuance, DNS, and long-term operation. Those remain separate milestones.
