# {{name}}

PSO orchestrator (TypeScript, Node.js 24): the single public entry point of the workspace. It authenticates callers, validates their
input, authorizes each route and calls the microservices through PSO service discovery. It does not own data.

## Structure

```text
src/
├── .app/                     application-wide components (version-controlled source, not infrastructure)
│   ├── configs/              *.config.ts   plain configuration modules, imported where needed
│   ├── contracts/            *.contract.ts / *.contract.json   contracts shared by several modules
│   ├── filters/              *.filter.ts   error filters named by routes
│   ├── guards/               *.guard.ts    authentication / authorization (jwt.guard.ts: the framework JWT guard)
│   ├── middlewares/          *.middleware.ts   run before the action of the routes that name them
│   ├── interceptors/         *.interceptor.ts  run around the action of the routes that name them
│   └── decorators/           *.decorator.ts    reusable decorators
├── modules/                  business functionality, one directory per module
│   └── <module>/
│       ├── MODULE.pso.ts     what the module owns (controllers, providers) - its registration
│       ├── routes/ROUTES.pso.ts   the endpoints it exposes and their access policy (nothing else is reachable)
│       ├── controllers/      HTTP: validated input, delegation, status codes
│       ├── services/         orchestration of an operation
│       ├── providers/        calls to microservices (UpstreamClient: discovery, TLS/mTLS, caller identity)
│       ├── contracts/        the microservice API the module depends on
│       ├── dto/request/      validated request bodies (@Dto)
│       ├── dto/response/     response contracts
│       └── mappers/          microservice record -> public response
├── shared/                   reusable code that belongs to no single module
└── main.ts                   starts the application; nothing else
tests/                        unit tests (npm test)
docs/                         project documentation
```

Directories are created when something goes in them. `.infra/` at the workspace root is different: it holds the operational
infrastructure PSO manages (certificates, secrets, generated configuration) and is never edited by hand.

Generate code in the right place with `pso make:<kind>`: `make:crud`, `make:module`, `make:controller`, `make:service`,
`make:provider`, `make:dto`, `make:mapper`, `make:contract`, `make:route` (module components, registered in MODULE.pso.ts / ROUTES.pso.ts
for you), and `make:guard`, `make:middleware`, `make:filter`, `make:interceptor`, `make:decorator`, `make:config` (application-wide, in `.app/`).

{{crudSection}}
## Run

```bash
npm install
pso dev                       # every service of the workspace, this orchestrator included
npm test                      # unit tests in tests/
```

The container image is built by `pso docker:build` / `pso docker:up`, which writes this project's Dockerfile the first time (it compiles
`src/`, `.app/` included).
