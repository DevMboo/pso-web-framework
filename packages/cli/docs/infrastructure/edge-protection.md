---
title: Edge protection and native error responses
description: What the edge gateway no longer reveals about the software behind it, the error responses it answers itself (an HTML page for a person, RFC 9457 for a program), where those resources live, how existing workspaces adopt them, and what cannot be covered.
order: 4
status: implemented
keywords: [edge, nginx, error pages, server header, x-powered-by, information disclosure, problem details, plain http, 497, 421, security headers, fingerprinting]
related: [infrastructure/security-and-certificates, infrastructure/containers, infrastructure/remote-hosts, infrastructure/troubleshooting, security/attack-prevention]
---
> [!STATUS]
> **Implemented and verified (0.2.0-rc.8)** with real HTTP and HTTPS requests to the real edge: a workspace created and started by rc.7, reconciled by rc.8, exercised through Chrome (OIDC sign-in, microfrontend composition, browser WebSockets on ports 8443 and 443 with allowed and refused origins), the orchestrator's rate limit, frozen and stopped containers, a rejected configuration with the running edge kept, a rollback to rc.7, and a deployment to an isolated Linux host over SSH (image transfer, `nginx -t` on the host, automatic rollback). **Not exercised:** a production server, a deployment bundle run by an operator, and a configuration that passes PSO's checks but is rejected by nginx on a remote host (the same `nginx -t` step is verified locally). Automatic for every workspace that runs the docker runtime: there is nothing to configure.

## What the edge no longer gives away

Before rc.8, a plain HTTP request sent to the HTTPS port was answered with nginx's own page, `400 Bad Request — The plain HTTP request was sent to HTTPS port — nginx`, and every response carried `Server: nginx`. The status was right; the disclosure was not. The edge now:

- sends **no `Server` header** on any response, including the ones it generates itself. `server_tokens off` only hides the version, so the edge runs nginx with the headers-more module, which removes the header;
- removes `X-Powered-By`, `X-AspNet-Version` and `X-AspNetMvc-Version` from every upstream response;
- never sends nginx's built-in error pages: every status it produces is answered from its own pages, and nginx's internal statuses are mapped to the HTTP status a client understands (497, 495 and 496 to `400`, 494 to `431`). The internal code and nginx's message never appear;
- answers an **unknown host** (the default server) with a sanitized `421`, and a **malformed request** (invalid request line, missing `Host`, oversized headers, an over-long URI) with a sanitized `400`, `431` or `414`;
- keeps every diagnostic internal: the edge's log (`pso docker:logs edge`) has the path without its query string, the status, the upstream that answered and the id that the error response returns as `X-Correlation-ID`.

This removes the obvious identification. It does not make fingerprinting impossible: TLS behaviour, header order and timing still allow a determined observer to guess the class of software.

## A page for a person, a document for a program

Which form the edge uses follows PSO's routing, never the `Accept` header alone:

| Where the request goes | Error the edge itself produces |
|---|---|
| a shell's host (the FEI and its microfrontends under `/_mei/`) | HTML page |
| the shell's same-origin API path (`/api/...`) and `/channels` | `application/problem+json` |
| the API host | `application/problem+json` |
| the identity provider's host (Keycloak) | HTML page; its token, keys, user info, revocation, introspection, discovery (`.well-known`) and administration API answer problem documents |
| the pso-dev identity's key host | `application/problem+json` |
| any other host | HTML page (`421`) |

Pages exist for 400, 401, 403, 404, 405, 408, 411, 413, 414, 416, 421, 429, 431, 500, 501, 502, 503, 504 and 505. A problem document has the RFC 9457 shape with `type: "about:blank"`, the status's reason phrase as `title`, the `status` and a fixed `detail`; it carries no PSO error code because the request never reached the application.

**What is never intercepted.** Responses of the orchestrator and of the identity provider reach the client exactly as they were sent: their Problem Details, the status, `Content-Type`, `WWW-Authenticate`, `Retry-After`, `Allow` and `X-Correlation-ID`. A failed request is never turned into a `200`, and an API error is never replaced by HTML. Only the shells' static servers, which are part of the framework, are intercepted: a missing asset or a `405` there gets the edge's page, with its status.

**When nothing else runs.** The pages are inside the edge image. They need no FEI, MEI, orchestrator, service, identity provider, database, script, font, image or CDN: with every application container stopped, the shells answer `502` with the edge's page, the API answers a `502` problem document, and a frozen upstream answers `504` after the connect timeout.

**Headers of an error response.** `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'` (the page's only style is allowed by its hash), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Correlation-ID`. No `ETag` or `Last-Modified`.

**The pages.** One template for every status: the status, a short heading, one sentence, and where it helps a "Try again" (a reload of the same address) or "Go to the home page" (`/` of the same host) link. No redirect is ever built from a request header. They name no technology, framework, version, container, path or internal status, and show no branding; they adapt to the system's light or dark scheme and to a phone's width. English only.

## Where the resources live

The error handling belongs to the framework, like the Studio's assets and the documentation portal:

- **Source:** the `@pso/infra` package, `edge/` (the image definition, its main nginx configuration and the page template) and the status table of the infrastructure engine. They are resolved next to the installed package, so an installation can be moved and no absolute path is ever written anywhere.
- **Runtime:** the pages, the problem documents and the nginx snippets that serve them are generated into a temporary build context and exist only inside the **edge image**, `pso-edge:<hash>`. The tag is the SHA-256 of that build context: the configuration a release renders always runs on the image of that same release.
- **Workspace:** nothing. `.infra/nginx/<env>/edge.conf` only includes the snippets by their path inside the image; no page is written into the workspace, a FEI, a MEI or `.infra/`. The internal location that serves the pages answers `404` to a direct request, and no directory of the image is ever served.

The image is built from Alpine Linux (a pinned 3.24 base, by digest) with Alpine's own `nginx` (1.30, stable) and `nginx-mod-http-headers-more` packages from its security-maintained `main` repository (both BSD-2-Clause). It runs unprivileged on a read-only root file system, like the stock image it replaces. It is **built locally** by PSO the first time a stack that uses it starts (it needs the base image and Alpine's package repository once) and is **never pulled** (`pull_policy: never`, so a registry image of the same name is never used). The shells and the pso-dev key server keep the stock `docker.images.nginx` image: they are reached only through the edge; `docker.images.nginx` no longer applies to the edge.

### What the tag identifies

The tag identifies the framework's **inputs**: the Dockerfile (with the base image's digest and the package branch), the nginx configuration and every page and snippet. It does not identify a bit-for-bit output:

- The base image is pinned by digest and is the same everywhere.
- The two packages are pinned to the nginx **1.30** branch of Alpine 3.24, not to one build. Alpine keeps only the newest build of a package in a stable branch, so an exact pin would stop building the day Alpine ships a security fix. Two machines that build the same tag weeks apart can therefore get different patch builds of nginx 1.30 (the build records the exact ones in the image, in `/usr/share/edge/packages.txt`).
- The build fails if the nginx branch is not the expected one or if nginx rejects the image's own configuration, so a broken package combination never becomes a usable image.
- An image is reused as long as its tag exists: PSO never rebuilds it in the background. Security fixes arrive through the normal release lifecycle: a PSO release that changes any input (for example a new base digest) has a new tag, and the next `pso docker:up` builds it with Alpine's current fixes. A remote host receives exactly the image that was built and tested locally.

## Lifecycle

- **New workspaces:** protected from the first `pso docker:up`.
- **Existing workspaces:** `pso infra:apply` (in development the next `pso docker:up` does it) updates `edge.conf` and the compose file; `pso docker:up` builds the image and re-creates the edge. FEIs and MEIs are not regenerated, nothing is copied by hand, there is no migration step.
- **Validated before it is applied:** every `pso docker:up`, `pso docker:restart --recreate`, `pso deploy --env` and Studio start that starts the edge first has nginx test its configuration in a throwaway container with the real mounts (`nginx -t`). A configuration nginx rejects is never started, and a running edge keeps serving.
- **Remote hosts (SSH):** the edge image is built locally and transferred like the service images (only when the host does not have it); `nginx -t` runs on the host with the release's own mounts before the release starts. A rejected configuration leaves the running release untouched. A hand-edited edge configuration never gets that far: the deployment refuses drift before anything is sent to the host.
- **Failures never stop a healthy edge:** when nginx rejects a new configuration, or the image a configuration names cannot be built by the installed release (`PSO_EDGE_IMAGE_FOREIGN`), PSO stops before Compose touches the containers: the running edge is neither stopped nor re-created and keeps serving.
- **WebSockets (PSO Channels):** the edge forwards the external authority as `Host` (the matched host name plus the environment's public port when it is not 443; never a value the client wrote), and the engine gives the orchestrator the exact origins of the declared shells (`PSO_CHANNELS_ALLOWED_ORIGINS`, unless the application sets its own). A browser on a shell opens `wss://<shell>/channels` on any port; any other origin is refused with `403`.
- **Deployment bundles:** the bundle's `DEPLOY.md` names the edge image as a prerequisite: build it with this PSO release and copy it to the target (`docker save pso-edge:<hash> | docker load`).
- **Hand-edited configuration:** a changed `edge.conf` is drift. `pso infra:apply` keeps it as it is and warns; only `pso infra:repair --yes` replaces it (with a backup). PSO never overwrites it silently.
- **Upgrade, repair, relocation:** the resources travel with the installed `@pso/infra` (npm package, installer and portable distribution; every file is classified and checksummed by the release). `pso repair` restores them; `PSO_EDGE_RESOURCES_MISSING` names a damaged installation.
- **Rollback:** running an earlier release's `pso infra:apply` and `pso docker:up` re-renders that release's own edge configuration and image; the newer image is simply unused. Going forward again needs no migration either.
- **Check it:** `pso infra:validate --probe` sends a plain HTTP request to the TLS port and a request for an unknown host, and fails when either response names its software or the internal error.

## Supported environments and limits

| Environment | Covered |
|---|---|
| docker runtime, development (`pso docker:up`) | yes |
| docker runtime on a remote host over SSH (`pso deploy --env`) | yes (verified on an isolated Linux host) |
| deployment bundle run by an operator | yes, once the operator has loaded the edge image (the bundle names it; not exercised end to end) |
| process mode (`pso dev`) | not applicable: there is no edge |
| an existing nginx managed by the PSO agent (`pso release:nginx`, static deployments) | partly: PSO's managed files set `server_tokens off`; the `Server` header and nginx's own error pages belong to that host's nginx, which PSO does not replace |
| a load balancer, CDN or proxy in front of the edge | no: its responses are its own |

What no HTTP response can cover: a **TLS handshake** that fails (an unknown name without a certificate, an unsupported protocol, a missing client certificate), a client that sends its headers too slowly (nginx closes the connection without a response) and HTTP/2 protocol errors (the connection is reset). Application errors are the application's: the orchestrator and the Spring starters already answer RFC 9457 documents without exception text; an identity provider's own pages are its theme. There is no per-FEI branding of these pages and no configuration to turn the protection off.
