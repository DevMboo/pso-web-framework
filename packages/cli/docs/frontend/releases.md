---
title: Module Federation, releases and rollback
description: How a MEI is loaded from an approved release manifest, how releases are published, activated and rolled back independently on a site root, what is verified before a release runs, and how the native cloud deployment reuses all of it.
order: 7
status: partial
keywords: [module federation, manifest, release, publish, rollback, integrity, signature, active pointer, nginx, same origin, compatibility]
related: [frontend/security, frontend/overview, cloud/release-signing, cloud/deploy-a-release]
---
> [!STATUS]
> **Partially implemented.** Verified in real-browser runs on a local site root served like the generated nginx layout (31 of 31 checks): independent update, rollback, tampering, a missing release, an untrusted signer, strict Content-Security-Policy. The same functions run inside the cloud engine (see the page on native deployment, verified against a real nginx). **Not implemented:** signing with the credential-store signers of the signer commands (this uses an Ed25519 PEM key file). **Not done:** a deployment of the frontend to the Azure VM; the Commerce frontend was validated against the Azure backend through the SSH tunnel, served from a local site root.

## How the shell loads a microfrontend

The shell never loads a script URL it was handed. Its **runtime configuration** (published by the deployment next to the shell, never built into it) lists each approved MEI and where its release pointer is. Loading `mei-customers` does:

1. read `/_mei/mei-customers/active.json`, a tiny never-cached pointer to the active version and the SHA-256 of its manifest;
2. fetch the manifest `v/<version>/pso-manifest.json` and check that it matches that hash;
3. validate it: name, host, shared-context contract, shared dependency versions (React is a singleton: same major, and the shell not older than the MEI);
4. verify the Ed25519 signature when the site requires one (`requireSignature`) or when a signature and trusted keys are both present;
5. load the entry with a Subresource Integrity hash taken from the manifest, and every chunk with hashes embedded at build time;
6. check that the module is a PSO microfrontend of the expected name and compatible contract.

Locations must be same-origin under `/_mei/`, or an origin the configuration lists over HTTPS. A failure at any step shows a "module unavailable" page for that MEI and nothing else; configuration, trust, compatibility and signature failures are not retried, network failures are retried a bounded number of times.

## Releases on a site root

```bash
pso frontend:config --site ./site --auth oidc --oidc-issuer https://idp.example --oidc-authorize https://idp.example/authorize --oidc-token https://idp.example/token --oidc-client commerce-web --require-signature --trust-key release.pem --key-id release-1
pso frontend:build --base-path /commerce/ --sign-key release.pem --key-id release-1
pso frontend:publish fei-commerce --site ./site --base-path /commerce/
pso frontend:publish customers --site ./site
pso frontend:releases --site ./site
pso frontend:rollback customers --site ./site
pso frontend:nginx --site /srv/pso/sites/commerce --base-path /commerce/
```

A published version is **immutable**: publishing the same version with different bytes is refused, and nothing is ever deleted by publishing. Activation is one atomic write of the pointer, so a browser that already holds the previous version's files keeps working (they stay on disk and are served as immutable) while new page loads get the new one. Before activation PSO verifies the files against the manifest, the compatibility with the active shell (a release built for another React major or contract is refused and **not even copied**), and the signature policy. `frontend:rollback` points one MEI back to its previous (or a chosen) version after the same checks, so a MEI that is no longer compatible with a newer shell cannot be rolled back to by accident. Every activation is appended to `history.json`. The other microfrontends, the shell and the runtime configuration are not touched: in the verified scenario their files were byte-identical before and after an update.

`pso frontend:nginx` prints a same-origin configuration (`/commerce/` the shell, `/_mei/` the remotes, `/api/` the orchestrator, immutable caching for versioned files, `no-store` for pointers, and a Content-Security-Policy of `script-src 'self'; connect-src 'self'`). It is printed for review; the managed nginx adapter of the cloud engine generates the same locations from the same function when a shell is deployed natively.

## When a reload is needed

A compatible MEI release needs no shell rebuild and does not interrupt other MEIs. A user who already loaded a MEI keeps that version until the page reloads; PSO does not force a reload and makes no claim of zero-downtime deployment. A shell release that changes the shared-context major version requires publishing compatible MEIs first or refusing the shell.

## Limits and common mistakes

- Publishing a MEI before the shell fails: it is checked against the host it will run in.
- Changing files inside a published version directory by hand breaks the hashes; the browser then refuses them.
- Signing protects the release you publish, not the machine that holds the key: keep the key off shared servers.
- Rolling back the pointer re-enables an older signed release; protect write access to `active.json` like any deployment credential.
