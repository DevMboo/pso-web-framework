import type { CliNote } from "./cli-notes.ts";

/** Reference notes of the frontend commands (FEI and MEI). Usage lines and flags come from the command registry. */
export const FRONTEND_NOTES: Record<string, CliNote> = {
  "fei:register": {
    examples: ["pso fei:register customers", "pso fei:register catalog --path /products --scopes catalog:read --title Catalog --icon catalog", "pso fei:register orders --dry-run"],
    effects: ["Adds an entry to `microfrontends` in `FEI.pso.ts` (mount path, entry scopes, loading mode) and prints the findings that mention the new MEI.", "Only the one file changes; the MEI project is not touched."],
    failures: ["The path overlaps another microfrontend's mount: names both and refuses.", "`is not a MEI of this workspace`: create it first with `pso create mei <domain>`.", "A `FEI.pso.ts` edited so that `microfrontends` is no longer a literal array cannot be edited by PSO: add the entry by hand."],
    see: ["frontend/declarations"],
  },
  "fei:unregister": {
    examples: ["pso fei:unregister customers"],
    effects: ["Removes the entry from `FEI.pso.ts`. The project directory and its workspace registration stay."],
    failures: ["`is not registered`: nothing to remove."],
    see: ["frontend/declarations"],
  },
  "frontend:validate": {
    examples: ["pso frontend:validate", "pso frontend:validate --json"],
    effects: ["Reads the declarations without executing them and checks relationships, route ownership and conflicts, contract compatibility, orchestrator contract freshness and the architecture rules (no router inside a MEI, no absolute URL in fetch). Also part of `pso validate`."],
    output: "fei-commerce: 3 microfrontend project(s), 10 route(s)\nOK",
    failures: ["Exit code 1 with a diagnostic that names the file and the configuration responsible, for example `PSO_FEI_ROUTE_CONFLICT`.", "Warnings do not change the exit code."],
    see: ["frontend/declarations", "frontend/troubleshooting"],
  },
  "frontend:inspect": {
    examples: ["pso frontend:inspect", "pso frontend:inspect fei-commerce", "pso frontend:inspect customers --json"],
    effects: ["Prints identity, port, orchestrator, middleware order, mounts and effective routes of a project."],
    failures: ["`Unknown frontend project`: names the known projects."],
    see: ["frontend/declarations"],
  },
  "frontend:routes": {
    examples: ["pso frontend:routes", "pso frontend:routes --json"],
    effects: ["Lists every effective browser route of the ecosystem with its owner, target and scopes, sorted by path."],
    failures: ["Exit code 1 when two projects (or one) declare the same effective path."],
    see: ["frontend/routing-and-middleware"],
  },
  "frontend:graph": {
    examples: ["pso frontend:graph", "pso frontend:graph --mermaid"],
    output: "fei-shop (:4200)\n├── mei-customers (:9000)  /customers\n└── shop-gateway  (orchestrator, /api)",
    effects: ["Shows how the shell, its microfrontends and the orchestrator relate. `--mermaid` prints a diagram source."],
    failures: ["Prints nothing useful without a FEI: create one with `pso create fei <name>`.", "A MEI that is not registered appears as unlinked: run `pso frontend:validate` for the reason."],
    see: ["frontend/overview"],
  },
  "frontend:install": {
    examples: ["pso frontend:install", "pso frontend:install customers", "pso frontend:install --dry-run"],
    effects: ["Packs the framework packages this CLI ships into `vendor/pso` of each frontend project, rewrites its dependencies to them and runs `npm install`."],
    failures: ["After a framework update npm may keep the old copy because the tarball has the same name and version: remove `node_modules/@pso` and `package-lock.json` first."],
    see: ["frontend/getting-started"],
  },
  "frontend:make": {
    examples: ["pso frontend:make middleware maintenance-window --project fei-shop", "pso frontend:make route /new --project mei-customers --dry-run"],
    effects: ["`middleware` writes `src/middlewares/<name>.ts` and lists it in the declaration (the FEI: last in the pipeline, move it where it belongs). `route` writes a page and adds the route to `ROUTES.pso.ts`."],
    failures: ["`is a built-in middleware name`: choose another.", "`Several frontend projects exist`: pass `--project`."],
    see: ["frontend/routing-and-middleware"],
  },
  "frontend:dev": {
    examples: ["pso frontend:dev", "pso frontend:dev --standalone customers", "pso frontend:dev --only fei-shop"],
    effects: ["Starts the declared development servers: the shell, every registered MEI, and a proxy from `/api` to the orchestrator. `--standalone <mei>` starts one MEI with the development host adapter (a simulated shell that exists only in that entry)."],
    failures: ["`Port N (project) is already in use`: nothing is started.", "`has no installed dependencies`: run `pso frontend:install`.", "Declaration errors stop the start; fix them with `pso frontend:validate`."],
    see: ["frontend/getting-started"],
  },
  "frontend:build": {
    examples: ["pso frontend:build", "pso frontend:build customers --base-path /commerce/", "pso frontend:build --base-path /commerce/ --sign-key release.pem --key-id release-1"],
    output: "fei-commerce          2.4 s     171.3 KB gzip\nmei-customers         2.6 s     209.5 KB gzip   release 0.1.0 (signed)",
    effects: ["Production build with hashed file names and integrity hashes. A MEI also gets `dist/pso-manifest.json`: every file with its SHA-256, the shared-context contract, the shared dependency versions and, with `--sign-key`, an Ed25519 signature.", "`--allow-dev-token` builds a validation shell that accepts a pasted token and shows a warning banner."],
    failures: ["A `shellKb` budget in `FEI.pso.ts` that is exceeded fails the build.", "`--sign-key` and `--key-id` go together."],
    see: ["frontend/releases", "frontend/styling-and-performance"],
  },
  "frontend:publish": {
    examples: ["pso frontend:publish fei-commerce --site ./site --base-path /commerce/", "pso frontend:publish customers --site ./site", "pso frontend:publish customers --site ./site --stage"],
    output: "mei-customers 0.2.0 is active (previous: 0.1.0; signed by release-1)",
    effects: ["Copies the build into an immutable versioned directory of the site root and activates it with one atomic pointer write; nothing published earlier is changed or deleted. `--stage` copies without activating."],
    failures: ["`no FEI release is active`: publish the shell first.", "`already published with different content`: published versions are immutable; increase the version.", "A release built for another React major or shared-context major, or with a signature the site does not trust, is refused and not copied."],
    see: ["frontend/releases"],
  },
  "frontend:rollback": {
    examples: ["pso frontend:rollback customers --site ./site", "pso frontend:rollback customers --site ./site --to 0.1.0"],
    effects: ["Points one MEI back to its previous (or a chosen) published version after the same compatibility and signature checks. The shell and the other MEIs are not touched."],
    failures: ["`has no earlier release`, `is not published on this site`, `is already active`.", "A version that is no longer compatible with the active shell is refused."],
    see: ["frontend/releases"],
  },
  "frontend:releases": {
    examples: ["pso frontend:releases --site ./site", "pso frontend:releases customers --site ./site --json"],
    effects: ["Shows the active shell and, for each MEI, the active version, the published versions and the activation history."],
    failures: ["`--site <directory>` is required.", "A site with nothing published shows no active FEI and no versions; it is not an error."],
    see: ["frontend/releases"],
  },
  "frontend:config": {
    examples: ["pso frontend:config --site ./site --auth none", "pso frontend:config --site ./site --auth oidc --oidc-issuer https://idp.example --oidc-authorize https://idp.example/authorize --oidc-token https://idp.example/token --oidc-client commerce-web --require-signature --trust-key release.pem --key-id release-1"],
    effects: ["Writes `pso-runtime-config.json` on the site root: where each approved MEI's pointer is, the sign-in provider, the same-origin API path and the trusted signing keys. It holds no secret and is not built into the bundle."],
    failures: ["`--require-signature needs at least one --trust-key`.", "OpenID Connect endpoints must be `https://` URLs.", "`dev-token` works only in a shell built with `--allow-dev-token`."],
    see: ["frontend/releases", "frontend/authentication-and-api"],
  },
  "frontend:nginx": {
    examples: ["pso frontend:nginx --site /srv/pso/sites/shop --base-path /commerce/"],
    effects: ["Prints a same-origin nginx configuration for the site root: shell, remotes and API kept apart, immutable caching for versioned files, no-store for pointers and a restrictive Content-Security-Policy. It is for review; PSO does not apply it."],
    failures: ["`Invalid --api`: a single path segment that is not under the shell's base path."],
    see: ["frontend/releases", "frontend/security"],
  },
  "frontend:declare": {
    examples: ["pso frontend:declare fei-commerce --connection azure --base-path /commerce/ --api-port 3000 --probe-port 8080", "pso frontend:declare customers --connection azure --environment production --probe-port 8080 --retain 5"],
    effects: ["Writes `deploy/<workspace>-fei.deployment.pso.ts` (shell) or `deploy/<workspace>-<domain>.deployment.pso.ts` (microfrontend) for the native engine: a static service, strategy `static`, the build output as an artifact. It holds no credential, only the name of a connection.", "Then use the normal commands: `pso release:plan`, `pso release:approve`, `pso release:deploy`, `pso release:rollback`."],
    failures: ["The shell needs `--api-port`, the loopback port that always reaches the orchestrator's active release (its `internalPort`).", "A microfrontend declaration never gets an nginx section: its releases are served through the shell's configuration.", "An existing declaration is not overwritten without `--force`."],
    see: ["frontend/native-deployment"],
  },
  "frontend:contracts": {
    examples: ["pso frontend:contracts", "pso frontend:contracts --check"],
    output: "orchestrator contract 3c1ca82a668b: 14 operation(s), 6 request DTO(s)\nupdated fei-commerce, mei-customers, mei-catalog, mei-orders",
    effects: ["Generates `src/models/contract.generated.ts` in every frontend project from the orchestrator's real routes and request DTOs, and `frontend/contracts/orchestrator.contract.json`. Response types are not generated because the orchestrator does not publish them."],
    failures: ["`--check` exits 1 when a project's copy is stale.", "The orchestrator's routes must validate first."],
    see: ["frontend/authentication-and-api"],
  },
};
