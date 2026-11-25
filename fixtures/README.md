# fixtures/

Everything that exists only to **validate** PSO Web lives here: standalone sample applications, generated projects, external validation workloads and the cross-language contract data. Nothing in `packages/`, `pso-java/` or `scripts/` may import, build or depend on code in this directory. The dependency points one way: a fixture consumes PSO through its public packages and the `pso` CLI.

| Directory | What it is | Used by |
|---|---|---|
| [`pso-commerce/`](pso-commerce/README.md) | **Functional and distributed-ecosystem validation**: the Commerce application (orchestrator, three Spring Boot services, local identity provider, Docker Compose) built with the CLI, consuming PSO from vendored package tarballs. | Local end-to-end and acceptance runs |
| [`pso-cloud-validation/`](pso-cloud-validation/README.md) | **Cloud deployment, infrastructure, operational security and remote management validation**: its own build of the same domain, the declarative deployments and the scenario scripts run against a real Azure VM. | External cloud validation (ECV, OHV) |
| [`contracts/`](contracts/README.md) | Language-neutral JSON contracts (JWT, problem, rate limit, dispatch, channels, HTTP conformance) read by both the TypeScript and the Java tests. | `packages/*/test`, `pso-java/**/src/test` |

The two Commerce fixtures are deliberately separate. They implement the same domain independently (different models, events, contracts and ports), and the cloud one is the application running on the Azure VM, so its source is not shared with the functional one. Keep functional tests in `pso-commerce` and deployment, infrastructure and operations tests in `pso-cloud-validation`.

## Rules

1. **A new validation project goes in `fixtures/<name>/`** with its own `README.md` stating its purpose, prerequisites and how to run it. Keep the workspace layout `pso create` produced (`pso.workspace.json`, `deploy/`, one directory per service): the CLI resolves the workspace from its root, so do not nest or rename those directories.
2. **Unit-test-only fixtures stay beside their tests** (`packages/<pkg>/test/fixtures/`, `scripts/fixtures/`). Move something here only when it is a standalone application, an external workload, or a contract shared by more than one language.
3. **No framework code reaches into a fixture.** A fixture reaches PSO through `@pso/*` packages (a `file:` path to `packages/<pkg>` or a vendored tarball) and the CLI.
4. **Fixtures are not distributed.** The distribution manifest (`dist.config.json`) is an allow-list that names no path under `fixtures/`, and each package's `files` allow-list covers only its own `dist`. `packages/cli/test/fixtures-isolation.test.ts` enforces both and fails if the framework imports from `fixtures/`.
5. **Fixture web interfaces stay in their fixture.** The Commerce playground (`pso-commerce/web`) is plain files shipped inside the gateway release; the framework has no knowledge of it. A fixture UI never talks to anything but the application it was deployed with.
6. **Scenario scripts take their target from the environment** (host, user, key path), never from literals, and are kept with the fixture, not in a temporary directory.
7. **Nothing generated or secret is committed**: dependencies, build output, release artifacts, signed manifests, `.env` files, certificates and private keys (see the root `.gitignore`). Generate them locally with the commands in each README.
