---
title: Remote hosts and SSH deployment
description: Registering a Linux host, what PSO checks on it, the remote deployment lifecycle over SSH, status, logs, rollback and its limits, and how credentials stay out of the workspace.
order: 9
status: implemented
keywords: [remote host, ssh, deploy, linux, docker, rollback, host key, credentials, staging, production]
related: [infrastructure/deployment, infrastructure/security-and-certificates, cloud/connect-a-server, infrastructure/troubleshooting]
---
> [!STATUS]
> **Implemented and verified** against an isolated, disposable Linux host reached over SSH (a Docker-in-Docker container with sshd, key-only login, an unprivileged deploy user): registration with a pinned host key, inspection, prerequisite checks with the operator's own certificates and secret files, a verified deployment, status and logs from the host, an automatic rollback of a failing release, an explicit rollback, the deployment lock, and the same operations from Studio. **Not done:** a deployment to a real production server (by design during framework development); installing Docker or opening firewall ports (PSO never does that).

An environment whose `deploy.target` is `ssh` is deployed to a Linux host that PSO reaches over SSH. Nothing about the host is provider-specific: any machine with Docker Engine, Compose v2 and an SSH server works.

```json
"staging": {
  "kind": "staging", "domain": "staging.example.com", "runtime": "docker", "httpsPort": 443,
  "tls": { "source": "external", "dir": "/etc/pso/staging/tls" },
  "secrets": { "provider": "file", "dir": "/etc/pso/staging/secrets" },
  "deploy": { "target": "ssh", "connection": "staging-host", "root": "/srv/pso" }
}
```

`tls.dir` and `secrets.dir` are paths **on the host**: the operator places the certificates (PSO layout) and the secret files there. They never travel from your machine.

## Registering a host

A host is a connection, registered once on each machine that deploys:

```bash
pso connection:add staging-host --host staging.example.com --user deploy --auth agent --accept-host-key SHA256:...
```

- The SSH host key is **pinned** after you approve its fingerprint (obtain it out of band); a different key later is a refusal, never a prompt. Host-key verification cannot be disabled.
- Credentials: the SSH agent (`--auth agent`), a key file that stays where it is (`--auth key --key <file>`: only its path is recorded), or a password/passphrase kept in PSO's protected credential store (`--password-stdin`, `--passphrase-stdin`). Nothing is written to the workspace or to `pso.infra.json`.
- A jump host (`--jump user@bastion:22`) is checked with the same strict options.

## What PSO checks on the host

`pso host:inspect <connection>` reads the operating system and architecture, Docker and Compose versions usable by the deploy user, free disk under the root, listening ports, existing PSO deployments and whether the host can resolve Docker Hub. `pso host:check --env <name>` turns that into the prerequisites of one environment:

| Check | Blocks the deployment when |
|---|---|
| docker / compose | missing, stopped, or the deploy user is not in the docker group |
| root | the deployment root (or its nearest existing parent) is not writable |
| disk | less than 1 GB free (warning under 4 GB) |
| ports | the edge port is used by something that is not this environment |
| tls | `ca.crt` or a `tls.crt` is missing, not issued by the authority, expired, or lacks a required name; a key is missing or unreadable (keys are only tested, never read) |
| secrets | a secret file is missing or empty (never read) |

PSO never installs packages, changes the firewall or creates users. Every check prints what the administrator must do.

## The deployment lifecycle

`pso deploy --env staging --dry-run` checks the host and prints the plan. `pso deploy --env staging --yes`:

1. resolves the environment and applies pending configuration (never generating keys or secrets outside development);
2. validates the host prerequisites (above); nothing changes on the host when one fails;
3. takes the environment's lock on the host (`<root>/<project>/.deploy-lock`, an atomic directory) and locally: concurrent deployments of the same environment are refused;
4. builds the service images here (and the framework's edge image when this machine does not have it yet) and assembles the release: generated configuration and published sites with a `MANIFEST.sha256` (no key, no secret);
5. transfers the release over SSH and verifies **every checksum on the host** before going on;
6. transfers only the images the host does not already have (compared by layer identity; `docker save | docker load`, no registry needed);
7. has nginx on the host test the release's edge configuration with its own mounts (`nginx -t`): a rejected configuration stops here and the running release is untouched;
8. starts the release in dependency order and waits until every container is healthy. Containers run as the owner of the operator's certificates and secret files (written to the release's `.env` as `PSO_CONTAINER_USER`); root is refused;
9. verifies through an SSH tunnel to the host's edge, with the operator's authority: shells, runtime configurations, API readiness, the identity provider's discovery (issuer and endpoints), refusal of unknown hosts, and that plain HTTP and unknown hosts are answered without identifying the software;
10. activates the release (`current` symlink, `history.json`), or
11. if starting or verification fails and a previous release exists, starts the previous release again.

## Status, logs, rollback

```bash
pso deploy:status --env staging          # active release, releases on the host, containers and health, lock
pso deploy:logs gateway --env staging --tail 200
pso rollback --env staging --yes         # the release before the active one; --to <release> for another
pso deploy:unlock --env staging --yes    # a lock an interrupted deployment left (refused if it cannot be removed)
```

## Rollback limitations

- Named volumes (databases) belong to the Compose project and are kept across releases and rollbacks.
- **Database migrations are not reverted.** Flyway migrations are forward-only: a rollback starts the previous application against the current schema. Keep migrations backward compatible (expand, then contract in a later release).
- The first release of an environment has nothing to roll back to: a failing first release is left running for inspection.
- Keycloak realm changes in staging/production are not part of a release: reconcile them with `pso infra:identity --env <name>` (see [identity reconciliation](/infrastructure/identity-reconciliation)).

## Production prerequisites

Before the first deployment of a `production` environment, the operator provides, on the host:

- Docker Engine and Compose v2, an unprivileged deploy user in the `docker` group, SSH key or agent login (password login disabled), and the host's key fingerprint obtained out of band;
- the edge port reachable from the users (firewall and DNS are the operator's: `dns.provider: "external"`);
- certificates from the organisation's authority in the PSO layout under `tls.dir` (`ca.crt`, one `tls.crt`/`tls.key` per container with the names `pso host:check` lists), owned by the deploy user, keys readable by that user only;
- every secret file under `secrets.dir` (`pso host:check` lists the expected names; contents are never read or copied by PSO);
- backups of the database volumes: PSO keeps volumes across releases but does not back them up;
- the people: outside development the generated realm carries clients and roles but **no users**; Keycloak imports it on its first start only when the realm does not exist yet, and users, credentials and identity federation remain the organisation's. Later client changes: `pso infra:identity --env production`.

Then: `pso host:check --env production` (all green), `pso deploy --env production --dry-run`, review, `pso deploy --env production --yes`.

## What goes wrong

- `Host key verification failed` (from OpenSSH): the host presents another key than the one you approved; find out why before re-registering it.
- `... belongs to root`: give the certificates and secret files to an unprivileged user, readable by that user only.
- `another deployment of "staging" is running`: wait; `pso deploy:unlock` only after you made sure it is not.
- A port in use on the host: stop what holds it or change `httpsPort`; nothing was changed.
