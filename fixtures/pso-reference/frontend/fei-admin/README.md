# fei-admin

The application shell (FEI) of this workspace: layout, navigation, sign-in and session, the middleware pipeline, notifications, and the
single connection to the orchestrator (`gateway`). Microfrontends (MEIs) are rendered inside it.

```bash
npm install
pso frontend:dev            # from the workspace: starts this shell and every registered MEI
npm run dev                 # this shell only (port 4201)
npm run build               # production build into dist/
```

What you edit: `FEI.pso.ts` (identity, security, middleware order, registered MEIs), `ROUTES.pso.ts` (routes of the shell), `src/layouts`
(the shell), `src/components`, `src/pages`, `src/security`, `src/middlewares` (your own navigation middleware).

What the framework manages: Module Federation, route plumbing, the runtime configuration and `.pso/generated` (never edit it).

Security notes: the access token lives in memory only and is never given to a MEI; navigation checks in the browser are a user
experience, the orchestrator enforces access. Read the documentation page "FEI security" before changing the sign-in.
