---
title: Resource lifecycle: ownership, drift, repair and recovery
description: How PSO decides what to create, update or leave alone, how it detects hand edits, how an interrupted run is completed, and how rotation works.
order: 3
status: implemented
keywords: [idempotent, ownership, drift, repair, reconciliation, journal, lock, recovery, rotation, state.json]
related: [infrastructure/overview, infrastructure/contract, infrastructure/security-and-certificates]
---
Every resource has a **status** (what the disk says now) and a planned **action** (what applying would do). `pso infra:plan` shows both and changes nothing.

| Status | Meaning | Action |
|---|---|---|
| `ok` | present and valid | none |
| `missing` | not there yet | `create` (if PSO may generate it), otherwise `supply` |
| `invalid` | there but unusable: wrong authority, missing host name, mismatching key, expired, unreadable | `replace` (PSO-owned) or `supply` |
| `outdated` | configuration PSO wrote, and the declarations changed since | `update` |
| `drifted` | configuration whose content PSO did not write (edited by hand, or never PSO's) | `repair`, only with `pso infra:repair --yes` |
| `exposed` | a key or secret readable by others | `protect` (restrict the permissions; nothing is regenerated) |
| `external-ok` / `external-missing` | an operator-supplied resource, verified / absent or invalid | none / `supply` |
| `external-unverified` | supplied on the deployment host, not visible from this machine (a secret variable, a remote directory) | listed as a deployment prerequisite |

## Idempotency

A second `pso infra:apply` reports `nothing to do`. Certificates are compared with what they must be (issuer, names, validity, key), not with when they were made: a certificate is replaced only when it would not work. Secrets are never regenerated once they exist. Rendered configuration is deterministic (no timestamps, stable ordering), so "nothing changed" is detectable byte for byte.

## Reconciliation

`pso create service|fei|mei`, `pso fei:register` and `pso fei:unregister` call the engine after they change a declaration. Development environments are reconciled at once and the command prints what changed and which running containers need a restart. For example, creating a third shell gives:

```text evidence="verified"
reconciled "local" after creating FEI "fei-partners": cert:edge, identity:realm, nginx:edge, site:fei-partners, nginx:fei-partners, runtime-config:fei-partners, docker:compose, hosts
  restart if the stack is running: pso docker:restart edge fei-partners idp --env local
```

The edge certificate is re-issued because it must name the new host, the realm gets the shell's OIDC client with its redirect URIs, the edge routes the new host, and nothing else changes (the other certificates keep their fingerprints). Staging and production environments that were provisioned before only get the list of affected resources and `pso infra:apply --env <name> --yes`.

## Drift and ownership

PSO records the SHA-256 of every file it writes in `.infra/state.json`. On the next run:

- content equal to what PSO would write now: `ok`;
- content equal to what PSO wrote last time, but the declarations changed: `outdated`, updated automatically;
- any other content: `drifted`. Apply skips it and says so; `pso infra:repair` (which needs `--yes` when it would overwrite something) regenerates it and keeps the edited file in `.infra/backups/<run>/`.

The right place for a change is the declaration it derives from; a hand edit of generated configuration is lost on repair by design. Developer-owned files are never managed: a service `Dockerfile` is created once when missing (marked as generated) and never overwritten afterwards; the 0.1 `docker-compose.yml` is never touched.

## Interrupted runs

Every write is atomic (a temporary file in the same directory, then one rename). Before writing a resource the engine records it in `.infra/journal/`; the record is removed when the resource is complete. A certificate is written key first and certificate last, so an interruption leaves a pair that does not match, which the next inspection detects as invalid. The next `pso infra:apply` reports the interrupted resources, removes partial temporary files and completes the work. One lock (`.infra/state.lock`) keeps two provisioning runs apart; a lock left by a process that no longer exists is taken over and reported.

## Rotation

Rotation is explicit: `pso infra:rotate <resource> --env <name> --yes` replaces a valid certificate, authority, signing key or secret. Rotating the authority re-issues every certificate it signed in the same run. Running containers keep the old material until they restart; the command lists them. Operator-supplied material is rotated at its source.

## Recovery and what goes wrong
- An interrupted run: the next `pso infra:apply` reports it and completes it; nothing to do by hand.
- Restoring `.infra/state.json` from another machine makes every generated file look drifted: delete the file and run `pso infra:repair --yes` to record fresh hashes (key material and secrets are kept).
- Deleting `.infra/ca/<env>` replaces the development authority on the next apply and re-issues every certificate of that environment.
