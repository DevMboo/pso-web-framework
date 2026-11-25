---
title: The runtime agent, modes and enrollment
description: What the agent is, why it opens no port, how the first administrator is created without a stored password, and how teammates are invited and revoked.
order: 3
status: implemented
keywords: [agent, enrollment, superadmin, roles, rbac, modes, protected, disabled, token, revoke]
related: [cloud/connect-a-server, cloud/credentials-and-security, cloud/pipelines-and-policy, cloud/troubleshooting]
---
The *runtime agent* is a single bundled file, `pso-agent.mjs`, that PSO uploads to `~/.pso-agent/bin/` over SSH. It needs only Node.js on the server, no `npm install`, and runs as an **ordinary user**, never requiring root.

## A private management plane

The agent has **no listening socket**. Your client starts it through the authenticated SSH connection (`ssh ... node pso-agent.mjs serve`) and speaks newline-delimited JSON on its standard input and output. There is therefore no management endpoint to publish: generated nginx files never mention it, and PSO adds nothing to Docker or the firewall. It is also not a remote shell: the protocol has a fixed list of operations (`release.start`, `service.restart`, `audit.read` ...), and anything else answers `UNKNOWN_OPERATION`.

## Modes

```bash
pso agent:install prod --mode protected --environment production --yes
```

| Mode | Meaning |
|---|---|
| `disabled` | The agent refuses every operation. This is what a server is until someone chooses otherwise. |
| `development` | Relaxed defaults (no approvals required, longer sessions). Authentication is still mandatory. |
| `protected` | Production defaults: approvals required, shorter sessions. |

`--mode` has no default on purpose. A host administrator re-enables a disabled agent with `pso-agent set-mode`, run on the server; the protocol cannot do it for them.

## How the first administrator exists

At provisioning the agent generates its own Ed25519 identity (the private key stays in `~/.pso-agent/identity/`, mode 600) and one **single-use enrollment token** for the role *superadmin*, valid for 30 minutes and stored only as a hash. `agent:install` receives it over the authenticated SSH channel and spends it immediately by presenting **your public key**, which you proved you own by signing a server nonce. Your private key goes into your credential store. No permanent administrator secret exists on the server, none travels to your machine, and nothing is printed to a log. There are no passwords in the agent, so there is no password verifier to leak.

## Recovering administrative access

If the last superadministrator is lost (a laptop gone, a key suspected), recovery is a **host-administrator** action, not a remote one. Someone with a shell on the server as the agent's user runs:

```bash
node ~/.pso-agent/bin/pso-agent.mjs recover-admin --minutes 15
node ~/.pso-agent/bin/pso-agent.mjs recover-admin --revoke-all     # when a client key may be compromised
```

It prints a new **single-use, short-lived** superadministrator enrollment token (at most 60 minutes) and writes an `admin.recovery` audit entry; `--revoke-all` first ends every client and session. You then enroll a **new** client key with `pso agent:enroll` and revoke or rotate the old identities. The operation is **not** in the management protocol (an agent asked for it answers `UNKNOWN_OPERATION`), so it cannot become a remote authentication bypass: it needs the same access as owning the agent's files. It never reveals or resets an existing identity.

## Roles, invitations, revocation

Roles ascend: `viewer`, `operator` (restart services), `deployer` (plan, approve, deploy, roll back), `admin` (audit, secrets, clients, provisioning), `superadmin` (policy, roles).

```bash
pso environment:access production --invite deployer --minutes 15
pso agent:enroll prod
pso environment:access production --revoke SHA256:AbCd...
```

An invitation cannot grant more than its creator holds, is single use and expires. Revoking a client ends all its sessions at once. The last superadministrator cannot be revoked.

## Every request is signed

After a handshake the client signs each request with its key over the session, a growing sequence number, the time, the operation and a hash of the arguments. A captured request cannot be replayed (the sequence only grows) or altered (the hash is signed). Failed authentications are rate limited per client and per source, with growing lock-outs.

## Agent releases and rollback

The agent is installed as **versioned releases**, not as a file that an upgrade overwrites. A release is identified by its semantic version **and** its build (the first 12 hex digits of its SHA-256), so two builds of `0.2.0` are two releases. The file the server runs is a link that is replaced by one atomic rename; the agent's identity, clients, policy, credentials and deployments live in separate directories that a release switch never touches.

```tree title="The agent directory on the server"
.pso-agent/
  bin/
    pso-agent.mjs # a link to the active release, replaced atomically
  releases/
    0.2.0+3f9a1c2b7d10/
      pso-agent.mjs # immutable; its checksum is verified again before it is activated
      release.json # version, build, sha256, installation time, installer, compatibility
    0.1.0+8c01aa42e9b3/ # the file that was installed before releases were versioned: adopted, not discarded
    state.json # the active release, the history and the retention
  identity/ # the agent's identity: never part of a release
  policy.json # the server policy: never changed by an upgrade
```

```flow title="What pso agent:upgrade does on the server"
[upgrade] upload to a temporary name -> verify the SHA-256 -> start the new file (version check) -> store it as an immutable release -> switch the link atomically -> keep the history and apply the retention
[refused] checksum mismatch or a build that does not start -> the running agent stays exactly as it was # nothing is activated
```

`pso agent:releases <connection>` lists the active and previous releases with their checksums, installation times and installers, and the history. `pso agent:rollback <connection> --yes` returns to the previous release, or to one named with `--to`: the target's checksum is verified against the one recorded when it was installed, it must start, and only then is the link switched. A release whose bytes changed on disk is refused. Retention (default 5) never removes the active or the previous release. The first versioned upgrade adopts the plain file that was running as a release, so even a server installed before this existed gets a real rollback point from then on; what was overwritten by older upgrades cannot be recovered and is not reconstructed.

## What can go wrong

- *`enrollment refused`*: the token is invalid, expired or used. The server deliberately does not say which, and repeated attempts lock the source out.
- *`remote management is DISABLED`*: choose a mode with a host administrator.
- *`agent not provisioned`*: run `agent:install`.
- Upgrades are explicit (`pso agent:upgrade --yes`): the agent never updates itself. Every build is kept as a release (see below), so the previous one can always be returned to. Protocol versions are negotiated; if no common version exists both sides say so and nothing proceeds.
- `pso agent:uninstall` removes only management tooling. Applications and their data stay unless `--purge-applications` is given, which is refused while services run.
