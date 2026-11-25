---
title: Connect to a Linux server
description: Register a VPS over SSH with strict host identity, choose how you authenticate, and test every layer of the connection.
order: 2
status: implemented
keywords: [ssh, vps, connection, host key, known_hosts, bastion, jump host, tunnel, passphrase, ssh-agent]
related: [cloud/overview, cloud/agent-and-enrollment, cloud/credentials-and-security, cloud/troubleshooting]
---
A *connection* is a named reference to a server: host, port, user, how you authenticate and the SSH host key you approved. It lives on your machine (in `~/.pso-cloud`, or `PSO_CLOUD_HOME`) and holds **references to credentials, never the credentials**.

```bash
pso connection:add prod --host 203.0.113.10 --user deploy --auth key --key ~/.ssh/id_ed25519
pso connection:test prod
```

## Host identity comes first

`connection:add` asks the server for its SSH host keys and shows their fingerprints. You compare one with what your provider's console shows (or run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server), approve it, and PSO pins it in its own `known_hosts`. From then on every connection uses `StrictHostKeyChecking=yes` with `BatchMode`: a changed key is a **hard failure**, never a prompt. In scripts the approval is explicit:

```bash
pso connection:add prod --host 203.0.113.10 --user deploy --auth key --key ~/.ssh/id_ed25519 --accept-host-key SHA256:AbCd...
```

## Authentication choices

| Choice | How | Where the secret lives |
|---|---|---|
| ssh-agent (default) | `--auth agent` | in your agent; PSO never sees it |
| Private key file | `--auth key --key <file>` | the file stays where it is; PSO stores only its path |
| Passphrase-protected key | add `--passphrase-stdin` | the protected credential store |
| Password (explicit alternative) | `--auth password --password-stdin` | the protected credential store |

Secrets are never arguments (they would appear in shell history and process lists). Pipe them on standard input or type them at the hidden prompt. Private keys are used in place with `IdentitiesOnly`; they are not imported or copied.

## Custom ports, bastions, timeouts, tunnels

```bash
pso connection:add prod --host 10.0.0.5 --port 2222 --user deploy --jump ops@bastion.example:22 --timeout 20 --accept-host-key SHA256:AbCd...
pso connection:tunnel prod --remote-port 20001 --local-port 9001
```

The tunnel forwards a loopback port on your machine to a loopback port on the server, only while the command runs. Controlled reconnection applies to read operations (status, history, logs); a connection lost during a *change* is never retried blindly. See [recovery](/cloud/rollback-and-recovery).

## The test, layer by layer

`connection:test` reports SSH and host identity, the agent, the agent's pinned identity and your authenticated session, each on its own line, so you know which layer failed.

```text evidence="expected"
OK   ssh             connected as deploy@203.0.113.10:22; host key verified against the pinned SHA256:AbCd...
OK   agent           agent 0.1.0 (management mode: protected)
OK   agent-identity  SHA256:Zx9... verified by challenge-response and pinned
OK   session         authenticated as ana@pso-studio (role superadmin, environment production)
```

## What can go wrong

- *"No protected credential store is available"*: PSO refuses to store a password in plain text. On Linux install `libsecret-tools` with a running keyring, or set `PSO_CREDENTIAL_PROVIDER=encrypted-file` with `PSO_CREDENTIAL_PASSPHRASE` or `PSO_CREDENTIAL_KEYFILE`.
- *Exit code 3 from `connection:add`*: a non-interactive shell cannot approve a fingerprint; pass `--accept-host-key` after checking it out of band.
- *Host key verification failed*: the server was reinstalled or someone is impersonating it. Confirm with your provider, then `connection:remove` and add it again.
- The server must have Node.js 24 or newer for the agent. PSO does not install it.
