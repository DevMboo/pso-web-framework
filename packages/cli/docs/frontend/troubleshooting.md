---
title: Frontend troubleshooting
description: Symptoms you will see while developing and operating a FEI and its microfrontends, what causes each, and what to do, including errors that name the exact configuration responsible.
order: 10
status: implemented
keywords: [troubleshooting, errors, module unavailable, integrity, port in use, route conflict, contract, vendoring, login loop]
related: [frontend/getting-started, frontend/releases, frontend/declarations, reference/troubleshooting]
---
> [!STATUS]
> **Verified**: every entry below was observed, or is produced by a tested check. Messages are quoted as printed; ids and paths in them are illustrative.

## Symptoms

| You see | Cause | Do this |
|---|---|---|
| `PSO_FEI_ROUTE_CONFLICT ... microfrontends[2]: "mei-b" mounts "/orders/new", which overlaps "mei-a"` | two mounts overlap | give each MEI its own, non-nested prefix in `FEI.pso.ts` |
| `PSO_MEI_NOT_REGISTERED` | the MEI names a host that does not list it | `pso fei:register <name>` |
| `PSO_MEI_SCOPE_MISMATCH ... requires scope "x" to enter mei-y, but mei-y does not declare it` | the FEI gates entry on a scope the MEI does not know | add it to `security.scopes` of the MEI or remove it from the FEI entry |
| `PSO_MEI_CONTRACT_INCOMPATIBLE ... major versions differ` | the MEI was built for another shared-context major | rebuild the MEI against the shell's framework version |
| `PSO_MEI_OWN_ROUTER` | the MEI creates its own router | use `<Routes>`, `useNavigate` and `useParams` only |
| `Port 4200 (fei-shop) is already in use` | another process on the port | stop it or change the port in `pso.workspace.json` and the declaration |
| `<name> has no installed dependencies` | `npm install` was not run | `pso frontend:install` |
| Page shows "<name> is unavailable" with "the release information could not be fetched" | no active release (nothing published, or the pointer is missing) | `pso frontend:releases --site <dir>`, then publish |
| "... was refused: the manifest is not signed" / "does not match" / "not trusted" | the site requires signatures | publish a release signed with a key listed in the runtime configuration |
| "Failed to find a valid digest in the 'integrity' attribute" in the console | a served file differs from what the build recorded | republish the release; check that nothing rewrites JS on the way (minifying proxies, injected scripts) |
| `mei-customers 0.2.0 was not activated` with `shared dependency "react": the MEI needs ^19.0.0 but the host provides 18.3.1` | the release needs another React than the shell | align versions; the previous release stays active |
| `mei-customers 1.1.0 is already published with different content` | published versions are immutable | increase the version |
| Sign-in page appears again after a reload | production keeps the token in memory only | expected; you return to the page you asked for |
| `a production build refuses a development runtime configuration` | the site's configuration says `mode: development` | regenerate it with `pso frontend:config` |
| A framework update changed nothing in a project | the vendored tarball has the same name and version, so npm kept the old install | delete `node_modules/@pso` and `package-lock.json`, then `pso frontend:install` |
| On Windows Git Bash, `Invalid --base-path "C:/Program Files/Git/shop/"` | the shell rewrote an argument starting with `/` | set `MSYS_NO_PATHCONV=1` |

## A microfrontend is blank in the shell but works standalone

The usual causes are a second copy of React or React Router (the shared singletons are declared for you; do not override them in `rspack.config.ts`), a global CSS selector colliding with the shell, or a router created inside the MEI. `pso frontend:validate` finds the last one. Open the console: a version mismatch is reported by Module Federation with both versions.

## More symptoms seen while hardening

- **After sign-in the page shows "Access denied: missing scope".** The token has the permissions in a claim the shell did not read. The shell reads the configured claim and `scp`; check the provider's mapper (Keycloak: a realm-role mapper to `scp`) and that the access token (not only the ID token) carries them.
- **"Sign-in failed: there is no sign-in in progress" right after a successful login.** The callback was processed twice. Current builds redeem the code once; an older build needs rebuilding with the current `@pso/frontend-react`.
- **The token request is blocked by the browser.** The Content-Security-Policy `connect-src` does not list the provider: redeploy the shell with `--connect-src https://your-idp`, and add the application's origin to the provider's web origins.
- **A route with a dot in its last segment returns 404 from nginx.** Its ending looks like a real file extension. Declare it on the shell: `--route "/catalog/sku/:id"`.
- **Studio shows no Operations panel.** Start it with `pso studio --frontend-ops`; without the option it is read-only by design.
- **Tests that use React fail with "Invalid hook call" or `useContext` of null on Windows.** Run them from the upper-case drive spelling (`D:/...`); the lower-case one loads the framework twice.

## Collect this before asking for help

`pso frontend:validate --json`, `pso frontend:inspect`, the browser console, the correlation id shown on an error (it appears in the orchestrator's logs), and `pso frontend:releases --site <dir>` for release problems.

## Limits

- Studio shows the same findings (Frontend view) but cannot repair them.
- Dev servers use `localhost`; on machines where it resolves to IPv6 only, probes written for `127.0.0.1` will report a server as down.
