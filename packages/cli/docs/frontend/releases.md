---
title: Module Federation, releases and rollback
description: How a MEI is loaded from an approved release manifest, how releases are published, activated and rolled back independently on a site root, what is verified before a release runs, and how the native cloud deployment reuses all of it.
order: 7
status: partial
keywords: [module federation, manifest, release, publish, rollback, integrity, signature, active pointer, nginx, same origin, compatibility]
related: [frontend/security, frontend/overview, cloud/release-signing, cloud/deploy-a-release]
---
> [!STATUS]
> **Partially implemented.** Verified in real-browser runs on a local site root served like the generated nginx layout (31 of 31 checks): independent update, rollback, tampering, a missing release, an untrusted signer, strict Content-Security-Policy. The same functions run inside the cloud engine (see the page on native deployment, verified against a real nginx). Releases are signed either with a **local signer** of `pso signer:generate` (`--signer <name>`: the private key stays in the protected credential store, the key id is the signer's fingerprint, and the shell trusts it with `pso frontend:config --trust-signer <name>`) or with an Ed25519 PEM key file (`--sign-key <pem> --key-id <id>`). **Not done:** a frontend deployment on the external validation server (its web server could not read the agent's directory); the Commerce frontend was validated against that server's backend through the SSH tunnel, served from a local site root.

## How the shell loads a microfrontend

The shell never loads a script URL it was handed. Its **runtime configuration** (published by the deployment next to the shell, never built into it) lists each approved MEI and where its release pointer is. Loading `mei-customers` does:

1. read `/_mei/mei-customers/active.json`, a tiny never-cached pointer to the active version and the SHA-256 of its manifest;
2. fetch the manifest `v/<version>/pso-manifest.json` and check that it matches that hash;
3. validate it: name, host, shared-context contract, shared dependency versions (React is a singleton: same major, and the shell not older than the MEI);
4. verify the Ed25519 signature when the site requires one (`requireSignature`) or when a signature and trusted keys are both present;
5. load the entry with a Subresource Integrity hash taken from the manifest, and every chunk with hashes embedded at build time;
6. check that the module is a PSO microfrontend of the expected name and compatible contract.

Locations must be same-origin under `/_mei/`, or an origin the configuration lists over HTTPS. A failure at any step shows a "module unavailable" page for that MEI and nothing else; configuration, trust, compatibility and signature failures are not retried, network failures are retried a bounded number of times.

## Sign-in mode of a shell in an environment

In a workspace with `pso.infra.json`, each FEI's site configuration is managed by the infrastructure engine. Choose how users sign in to
one shell in one environment with `--env`; run it from the workspace root:

```bash
pso frontend:config --env local --fei shop --auth none     # the shop shell becomes public in "local"
pso frontend:config --env local --fei admin --auth oidc    # admin signs in through the environment's identity provider
```

The choice is recorded as `environments.<env>.frontends.<fei>.auth` in `pso.infra.json` and the engine re-renders that FEI's
`pso-runtime-config.json` (`.infra/sites/<env>/<fei>/`), so a later `pso infra:apply`, `pso docker:up` or `pso frontend:publish` keeps it.
Other FEIs and other environments are unchanged. `--auth none` only removes the shell's sign-in: the shell then shows its full layout to
every visitor, a microfrontend page that requires scopes answers "Access denied" (no visitor can hold a scope), public microfrontends
open (they are not listed in the navigation unless their entry in `FEI.pso.ts` sets `nav: true`), routes the orchestrator protects still
answer `401` to its requests, and the services keep their own rules. A production environment refuses `dev-token`, and a shell whose
`FEI.pso.ts` declares `security.authentication: "none"` stays without sign-in whatever the environment says. The OIDC, API-path and
signature options belong to a site you manage yourself (`--site`) and are refused with `--env`.

## Releases on a site root

```bash
pso frontend:config --site ./site --auth oidc --oidc-issuer https://idp.example --oidc-authorize https://idp.example/authorize --oidc-token https://idp.example/token --oidc-client commerce-web --require-signature --trust-key release.pem --key-id release-1
pso frontend:build --base-path /commerce/ --signer release-bot
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
