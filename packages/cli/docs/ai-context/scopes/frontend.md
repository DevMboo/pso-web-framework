---
title: Task: build the distributed frontend (FEI and MEI)
description: Rules and commands for creating a React application shell and microfrontends with PSO.
order: 40
scope: frontend
base: false
requires: [orchestrator]
keywords: [ai, task, frontend, fei, mei, react, microfrontend]
---
- A workspace has **one FEI** (application shell) and **one MEI per business domain**. Create them with `pso create fei <name>` and `pso create mei <domain> [--register]`, register with `pso fei:register <domain>`, run with `pso frontend:dev` (or `pso frontend:dev --standalone <domain>`), check with `pso frontend:validate`.
- `FEI.pso.ts`, `MEI.pso.ts` and `ROUTES.pso.ts` are **data** (literals only, read without being executed). Do not compute values in them. `rspack.config.ts` is one line; never write Module Federation configuration by hand and never edit `.pso/generated`.
- A MEI **must not** create a router (`BrowserRouter`, `HashRouter`, `MemoryRouter`), import the FEI's source, call an absolute URL, or ask for a token. It uses `usePsoContext()` for `user`, `hasScope`, `api`, `channels`, `notifications`, `navigate`.
- All backend calls go through `usePsoContext().api` (paths such as `/customers`) to the **orchestrator only**. Never call a microservice, a broker or a database from the browser.
- Browser guards and middleware are user experience, **not authorization**: put every scope on the orchestrator's route (`security.scopes` in `ROUTES.pso.ts` of the orchestrator).
- Request types come from `pso frontend:contracts` (`src/models/contract.generated.ts`). Response types exist only for routes whose `ROUTES.pso.ts` entry declares `responses: { 200: "CustomerResponse[]", 404: "problem" }` (a `@Dto()` class name, `Name[]`, `Name | null`, `void` or `problem`); never infer them from samples, and keep untyped routes untyped. Prefer `createOperations(api).call("GET /customers/:id", { params: { id } })` from the generated file over hand-written paths. Do not invent endpoints that the orchestrator does not publish; handle a 404 listing honestly.
- Sign-in is Authorization Code with PKCE in the shell (the provider's endpoints https, state and nonce checked, issuer and audience of the ID token validated, silent restore after reload, RP-initiated logout). The token is never given to a MEI. A route whose last segment ends in a real file extension needs `--route` when deployed behind the generated nginx. `pso studio --frontend-ops` enables validate/build/dev-server/local publish operations in Studio; remote deployment is the Cloud section.
- Styling: Tailwind utilities and the shared tokens (`bg-surface`, `text-muted`, `border-line`); a MEI never loads a CSS reset. Icons come from `react-icons`, never emojis.
- Release: `pso frontend:build <project> --base-path /app/`, `pso frontend:publish <project> --site <dir>`, `pso frontend:rollback <mei> --site <dir>`. Versions are immutable. Native deployment: `pso frontend:declare <project> --connection <name> ...` writes `deploy/<name>.deployment.pso.ts` (a static service), then `pso release:plan`, `release:deploy`, `release:rollback` work as for a service. Only a shell release can change nginx; a microfrontend never does.
- Module Federation is not a sandbox: do not claim a MEI is isolated from the shell.
