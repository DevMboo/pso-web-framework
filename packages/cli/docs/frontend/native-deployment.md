---
title: Deploying a shell and microfrontends with the cloud engine
description: How a FEI and its MEIs are deployed as static resources by the same plan, approval, signature, lock, history, atomic activation and rollback as a backend service, how nginx is managed for them, and how independent releases stay safe.
order: 7
status: implemented
keywords: [native deployment, static resource, release plan, nginx, site root, rollback, retention, recovery, independent release, atomic activation]
related: [frontend/releases, frontend/security, cloud/deploy-a-release, cloud/nginx-and-existing-infrastructure, cloud/rollback-and-recovery]
---
> [!STATUS]
> **Implemented and verified** with the engine run inside the Linux image of the cloud end-to-end tests, against a **real nginx** (`static-engine-nginx.test.ts`, `static-nginx.test.ts`), with in-process engine tests (`static-deploy.test.ts`), and in Chrome against the Commerce frontend deployed that way (26 of 26 navigation and workflow checks, 13 of 13 independent-lifecycle checks). **Not done:** a deployment of the frontend to the Azure VM, and an interrupted deployment with a real killed worker (recovery was verified with a simulated interruption).

A frontend is deployed with the engine you already use. There is no second deployment tool: `pso frontend:declare` writes a declaration, and `pso release:plan`, `release:approve`, `release:deploy`, `release:status`, `release:history` and `release:rollback` work on it as on any service.

```bash
pso frontend:build fei-commerce --base-path /commerce/
pso frontend:declare fei-commerce --connection azure --base-path /commerce/ --api-port 3000 --probe-port 8080
pso release:plan commerce-fei
pso release:deploy commerce-fei --approve --yes
pso frontend:build customers --sign-key release.pem --key-id release-1
pso frontend:declare customers --connection azure --probe-port 8080
pso release:deploy commerce-customers --approve --yes
pso release:rollback commerce-customers --yes
```

## What is different from a service

The declaration has a service with `runtime: "static"` and the strategy `static`. Nothing is started, so there is no port, no process, no drain. The build output (the `dist` directory) travels as the usual checksummed artifact; the plan, the signature and trust checks, the approval, the deployment lock, the state machine, the audit log and the history are the engine's own. Activation calls the **same functions** as `pso frontend:publish` (`@pso/frontend/release`, bundled into the agent), so the CLI and the engine cannot disagree about what a release is.

On the server everything lives in one **site root** per domain (`<agent home>/sites/<site>`), shared by the shell and its microfrontends:

```tree title="Site root of one domain on the server"
sites/commerce/
  fei/
    <version>/ # immutable shell releases (index.html, pso-fei.json)
    assets/ # one content-addressed pool of every shell release's hashed assets
    current.json # the active shell (and a `current` symlink)
  _mei/
    <name>/
      v/
        <version>/ # immutable microfrontend releases
      active.json # the active pointer, written atomically
      history.json # every activation
  pso-runtime-config.json # remotes, trusted signing keys, sign-in provider
```

## Who touches nginx

Only a **shell** release can change the web-server configuration. The managed file `pso-<app>.conf` is generated from one function shared with `pso frontend:nginx`, written through the adapter's usual transaction: back up, write, `nginx -t`, graceful reload, restore on failure. A shell release whose generated file is identical to the one in place changes nothing and reloads nothing. A **microfrontend** deployment never touches nginx at all (its declaration is refused if it asks for it): the shell's file already serves `/_mei/` for every microfrontend, so a compatible update is one pointer write and the nginx worker processes stay the same (verified by comparing their process ids).

The generated configuration serves the shell under its base path with the entry page as the fallback for every path that is not a file: a path is a file only when its extension is a known static-asset one (`js`, `css`, `json`, `png`, `svg`, `woff2`, `map`, `html`, `pdf` and the like), so an application identifier such as `/customers/acme.corp` or `/orders/ORD-1.2.3` is a route. A missing script or stylesheet is a **404** and never the entry page. Versioned remote files are `immutable`; the pointer, the history and the runtime configuration are `no-store`; text is compressed; every location repeats the security headers (nginx drops inherited `add_header` as soon as a location sets its own) with a policy of `script-src 'self'` and `connect-src 'self'`; the orchestrator is proxied under one prefix with WebSocket upgrades, and `/channels`. Nothing else under the site root, such as the lock directory or the release directories, is reachable.

## The lifecycle, and what keeps it safe

1. The candidate is verified against its manifest (hashes, files, signature policy of the site) and for **compatibility with the active shell** (shared-context contract, React major) before anything is copied into the site. An incompatible or tampered candidate fails the deployment and is not even staged.
2. It is copied into its own versioned directory, then activated with one atomic write. The previous version's files stay, so a browser tab that loaded them keeps working until it reloads.
3. The engine verifies the result **through nginx**: for a shell, that the entry page answers with this release and that a missing asset is a 404; for a microfrontend, that the pointer, the manifest (against the hash the pointer records) and the entry file served are the ones just published. A failure puts the previous release back.
4. A shell's hashed assets go into the shared pool, so a tab still running the previous shell resolves its lazy chunks after a new shell is activated, and one URL can never resolve to two contents.
5. Registry writes (pointers, history) happen under a site lock that is taken over from a dead process, so concurrent publishes cannot interleave.
6. Retention (`static.retain`, default 5) never removes the active version, the one it replaced, or fewer than two versions; the engine keeps its own release directories under the usual retention.
7. `release:rollback` points one resource back to its previous release after the same checks, so a microfrontend that no longer fits a newer shell cannot be rolled back to by accident.

## Recovery

An interrupted static deployment is reconciled from what exists, not by replaying steps. `release:recover` sweeps leftover staging directories and temporary files, checks every pointer against its manifest hash and files, and then either completes the deployment forward (the new version was already active and consistent) or closes it without touching the active release. If nginx already serves a configuration for a shell release that was never activated, the previous configuration is restored from its backup; if that cannot be done, the deployment is marked as needing an operator.

## Sharing the server of an existing application (one address, one certificate)

A shell normally owns a virtual host. When the application's public address and certificate already belong to another PSO application (typically the orchestrator on port 443), the frontend can **join that server** instead of competing for it:

- The **host** declares `nginx.attachPoint: true`. Its managed file then includes `<managed directory>/attach/<host>/*.conf` in its public server and in its loopback servers. That is the only change to the host, made by one ordinary deployment of it (blue-green, `nginx -t` first, rollback as always). The directory is a subdirectory, so the http-level include of the managed directory never loads a fragment by mistake.
- The **shell** declares `nginx.attachTo: "<host>"` (`pso frontend:declare ... --attach-to <host>`). It gets no server: the engine writes only its locations (`pso-<shell>.conf`, with the same ownership marker, transaction, `nginx -t`, graceful reload and restore as any managed file) into the host's directory, serves them under its base path, and verifies the release through the host's loopback listener (`--probe-port`). An attached shell declares no `api`: it reaches the orchestrator through the host's own routes, and its runtime configuration says so (`--orchestrator-path /`).
- Releases stay independent. Updating a microfrontend never touches nginx. Updating the shell rewrites only its fragment (the host's file is byte-identical afterwards). Deploying the host again keeps the include, so the attached frontend keeps being served. Frontend assets are never packaged in the host's release, and a frontend update never needs a host deployment or a restart.
- `location` rules decide by specificity, so the host's `/` keeps every route that is not under the shell's base path; the shell's own rules (`/commerce/...`, `/_mei/`, the asset pool) are more specific.

The shell's **runtime configuration** (`pso-runtime-config.json`: where the orchestrator is, how users sign in, which release signers are trusted) is declared too, so it is deployed and rolled back with the shell instead of being written by hand: `--orchestrator-path`, `--channels-path`, `--auth none|dev-token|oidc` with the `--oidc-*` options, `--require-signature` and `--trust-key <keyId>=<public key>`. It holds no secret.

The server's deployment policy decides which strategies it accepts; a server provisioned before frontends existed does not list `static` in `allowedStrategies`, and the plan says so (`BLOCKED: the server policy does not allow the "static" strategy`). Only the server's administrator changes that (`pso environment:policy <application> --set allowedStrategies=...`); no declaration can.

## What was tested for interruption and TLS

A real detached deployment worker was killed with SIGKILL at several moments after it reported `SWITCHING_TRAFFIC` (inside a Linux container with a real nginx), for shells and for microfrontends, and `release:recover` was run each time. The outcomes were: completed forward (the new version was already active and consistent), rolled back (nginx already served the new shell configuration but the shell was not active, so the backup was restored) or closed without touching the active release. In every case the lock was free afterwards, no staging file was left, the registry, the files and what nginx served agreed, and the next deployment worked. Two defects were found this way and fixed: recovery could not find the nginx backup when the worker died before recording its id (it now finds it by deployment name), and an activation killed between the pointer write and the history write is now completed by writing the missing history entry.

HTTPS was tested with a real nginx and a private certificate chain that the client verified strictly (no verification was disabled): the shell over TLS, the plain port redirecting with the path kept, HSTS and the security headers, routes and missing files as above, and a client that does not trust the chain refused. TLS 1.1 was refused by the client's own minimum, so that last check does not prove the server's protocol list on its own. A certificate from a public authority was not used.

If the browser must call an identity provider's token endpoint from another origin, declare it with `--connect-src https://idp.example.com`: it is added to the Content-Security-Policy `connect-src` (https only, plain http only for localhost). Nothing else is opened.

## Limits and common mistakes

- **One service per static deployment.** A shell and each microfrontend are separate deployments, which is what allows them to be released independently.
- The shell's nginx file needs `--api-port`, the loopback port that always reaches the orchestrator's active release; it is the orchestrator's `internalPort`. Without a managed orchestrator, the shell cannot reach its backend.
- When the shell uses TLS, the public port only redirects; declare `--probe-port` so the engine can verify the release through a loopback listener it adds to the same file.
- Without `--probe-port` a microfrontend is verified on the site root only (a warning is logged), not through nginx.
- Shell asset file names must be content-hashed (the production build produces them); a name that already exists in the pool with other bytes refuses the release.
- An identifier whose last segment ends in a real file extension (`/catalog/sku/acme.json`) still looks like a file. Declare such routes on the shell (`pso frontend:declare ... --route "/catalog/sku/:id"`, or `static.routes` in the declaration): a declared route is given the entry page before the file rules apply. `:name` matches one segment, a trailing `/*` anything below. Everything else that looks like a file and is missing stays a 404, and the API prefix, `/_mei/` and the asset pool never fall back to the entry page.
- An operator edit of the managed shell file through the file editor is refused by the existing lint because the file uses `root` and `alias`; change the declaration and deploy instead.
