---
title: Release signing and trusted signers
description: How a deployment proves who produced a release (authenticity) separately from whether the bytes are the ones named (integrity), how an environment requires signed releases, and how to generate, enroll, rotate, revoke and recover signing keys.
order: 15
status: implemented
keywords: [signature, signing, trusted signer, authenticity, integrity, manifest, ed25519, replay, downgrade, provenance, revocation]
related: [cloud/credentials-and-security, cloud/pipelines-and-policy, cloud/deploy-a-release, cloud/agent-and-enrollment]
---
> [!STATUS]
> **Implemented and verified** with unit tests and an in-process agent (`signing.test.ts`: tampering, wrong release, untrusted, revoked, expired, replay, start-time re-check, no bypass by pipeline or declaration). It has **not** been run against an external environment, and signing is **optional by default**: an environment opts in with `requireSignedReleases`.

## Two different questions

| Question | Called | Answered by |
|---|---|---|
| Are these the bytes that were named? | **Integrity** | an immutable commit id (git) or a SHA-256 checksum (artifact) |
| Did a signer this environment trusts produce that name? | **Authenticity** | a signature checked against the environment's trust store |

A checksum is integrity only: anyone who can change an artifact can change its checksum next to it. PSO reports the two separately in every plan, and never lets one stand in for the other.

## What is signed

A small canonical JSON **release manifest**: the application, the immutable source (the commit id and its git tree, or the artifact's SHA-256), an optional hash of the extracted file tree, a **strictly increasing sequence number** and the time. The signature is Ed25519 (the standard primitive of `node:crypto`; PSO has no custom cryptography) over the manifest with a domain-separation prefix, so a release signature can never be replayed as a request signature or the other way round.

## Where the keys live

- The **private key** is created on the signer's machine and stored in that machine's protected credential store. It is never in a project, a generated application, a package, a manifest, a pipeline or on a server, and PSO has no command that exports it.
- The **server holds public keys only**, in a trust store that **only a superadministrator of that environment** changes, with an audit entry for every change. No declaration, pipeline stage, CLI option or Studio setting can add a signer or switch the requirement off.

```bash
pso signer:generate release-bot
pso trust:add production --signer release-bot --apps shop-catalog --not-after 2027-06-01 --yes
pso environment:policy production --set requireSignedReleases=true --yes
```

## Signing and deploying

```bash
pso release:sign production --signer release-bot --sequence 12 --path ../shop-catalog
pso release:verify production --signed production.release.signed.json
pso release:plan production --signed production.release.signed.json
pso release:deploy production --plan <hash> --yes
```

`release:sign` reads the commit from a **clean** checkout (uncommitted changes are refused: the server deploys the commit, not your working tree). For an artifact release give `--artifact <file>`; the manifest then also carries the hash of the extracted tree, which the server recomputes after unpacking and refuses on any difference.

## What the server enforces (independently of the project)

| Check | Where |
|---|---|
| The signature verifies against a key in **this environment's** trust store | at planning, and **again at start** (a signer revoked after approval stops the deployment) |
| The signer is not revoked, not expired and allowed for this application | same |
| The manifest names exactly the commit or checksum the **server** resolved, for this application | same |
| The sequence is greater than the last signed release deployed (replay and downgrade) | at planning |
| The extracted content matches the signed tree hash | after unpacking, before building |
| A signature that is presented but unacceptable is refused even where signing is optional | at planning |
| Rollback, where signing is required, goes only to a release whose signer still qualifies | at rollback |

Every state has a name: `verified`, `unsigned`, `invalid-signature`, `untrusted-signer`, `revoked-signer`, `expired-signer`, `signer-not-allowed-for-app`, `manifest-mismatch`. Only `verified` is a pass.

## Rotation, revocation and recovery

- **Rotate**: generate a new signer, `trust:add` it, sign new releases with it, then `trust:revoke` the old one. During the overlap both are trusted. A key is never "re-keyed": a new key has a new id.
- **Revoke**: `pso trust:revoke production <key-id> --reason "key leaked" --yes`. It takes effect at once, also for plans already approved and for rollback. A revoked key is never accepted again by that environment, even if re-added.
- **Lost private key**: generate a new signer and trust it. There is nothing to restore, because nothing ever left the machine. If it may have leaked, revoke first.
- **Lost superadministrator**: use the host-administrator recovery in [Agent and enrollment](/cloud/agent-and-enrollment).

## Limits

- The source of truth for a git release is its commit id, which is a SHA-1 digest unless the repository uses the SHA-256 object format. Use artifact releases where that matters.
- A signature proves who vouched for a release, not that it is free of vulnerabilities or malicious code.
- There is no transparency log and no certificate authority: trust is an explicit list of public keys per environment.
