---
title: Distributed frontend: FEI and MEI
description: How PSO Web structures a browser application as one application shell (FEI) and independent business-domain microfrontends (MEI), why the pieces are split this way, and what each one owns.
order: 1
status: implemented
keywords: [fei, mei, microfrontend, module federation, application shell, react, rspack, tailwind, orchestrator]
related: [frontend/getting-started, frontend/declarations, frontend/security, concepts/declarative-architecture]
---
> [!STATUS]
> **Implemented and verified** with unit tests and real-browser runs (Chrome) against a multi-service sample application: a local Compose backend, and a cloud workload on a remote VM reached through an authenticated SSH tunnel. Frontends are deployed by PSO's own cloud engine as static resources (see "Deploying a shell and microfrontends with the cloud engine"), or published to a site root by `pso frontend:publish`; both use the same release functions. **Not done:** a deployment of the frontends to the remote VM.

PSO Web already describes a backend declaratively: an orchestrator, services, routes, contracts. The distributed frontend applies the same idea to the browser. A workspace gets **one application shell** and **one microfrontend per business domain**, each a normal React and TypeScript project, and the framework manages everything structural between them.

```architecture title="Where each piece runs"
Browser (client)
  FEI, the application shell (shell) # layout, sign-in, session, navigation, middleware, notifications, the one orchestrator connection
    MEI customers (microfrontend) # /customers/* | its own pages, hooks, state, tests and release
    MEI catalog (microfrontend) # /catalog/* | its own pages, hooks, state, tests and release
    MEI orders (microfrontend) # /orders/* | its own pages, hooks, state, tests and release
  PSO API client (library) # native fetch
    PSO orchestrator (orchestrator) # calls |
      services (service) # forwards to |
```

## Who owns what

| Concern | FEI (shell) | MEI (microfrontend) |
|---|---|---|
| Browser URL and history | owns the one router | uses `<Routes>` below its mount path; never creates a router |
| Sign-in, session, token | owns them; the token never leaves it | receives `usePsoContext()` (user, scopes, `api`, `channels`) |
| Layout and navigation chrome | owns them | renders only its own pages inside the shell |
| Middleware | owns the mandatory pipeline | may add domain middleware that runs after it and cannot weaken it |
| Business logic, state, components | none | all of it |
| Build and release | own project, own release | own project, own release |

## Why this split

A shell that every team edits becomes the bottleneck the split exists to avoid. A shell that does nothing becomes N applications that each reinvent sign-in. PSO takes the middle path: the shell is small and generic, and **everything a user should experience once** (identity, session, error handling, the connection to the backend) lives in it. A team that works on customers changes `mei-customers` and nothing else.

Two rules make the independence safe rather than accidental. A MEI **cannot import the FEI's source** and the FEI **cannot import a MEI's source**: they meet only through a versioned contract (the shared context, 1.0) and a manifest. And **no frontend talks to a microservice**: every request goes to the orchestrator, which is where tokens are verified and scopes enforced.

## What you write and what PSO manages

You write `FEI.pso.ts`, `MEI.pso.ts` and `ROUTES.pso.ts` (data, read without being executed), pages and components, and optional middleware. PSO manages Module Federation, the route table, the runtime configuration, shared React singletons, hashed assets and the release manifest. A generated `rspack.config.ts` is one line.

## Stack

React 18.3, TypeScript (strict), Tailwind CSS 4, React Icons, React Router 7, native `fetch` and `WebSocket`, Rspack 2.3 with Module Federation 2.9. These exact versions were built together and are pinned in the generated projects. Vite and Axios are not used.

## Limits and what this is not

- **Module Federation is not a sandbox.** A loaded microfrontend runs in the same JavaScript realm as the shell. PSO reduces mistakes (no token in the context, no direct URLs, manifests with hashes and signatures) but cannot contain malicious code. Treat every MEI as code with the same release standards as the shell.
- Browser checks (guards, scope-based navigation, middleware) shape the interface. They are **not** an authorization boundary; the orchestrator enforces access.
- PSO does not replace React. It adds structure around it.
- The shell loads microfrontends from approved manifests. A new MEI release that is compatible needs no shell rebuild; an incompatible one is refused before it runs.
- Real-time updates use the Channels connection the shell owns. A backend without Channels still works: the Orders page falls back to bounded polling.
