---
title: Task: diagnose a PSO error
description: How to find and fix the cause of a PSO diagnostic or a failing request.
order: 29
scope: diagnose-error
base: false
requires: [module-routes]
keywords: [ai, task, diagnose, error, troubleshooting]
---
1. Reproduce with `pso validate` (add `--json` for machine output). Read the **whole** diagnostic: for route errors it shows Module, Route, Controller, Action, Expected and Found.
2. Fix the cause in the source of truth. Mismatch between decorator and declaration: align them (prefer `pso make:route` for new routes). Never delete a guard, add `public: true` or loosen a policy to make an error disappear.
3. Symptoms:
   - decorated method answers 404: it is not declared in `ROUTES.pso.ts`.
   - every guarded request answers 401: the guard has no `PSO_JWT_*` configuration or the token's issuer/audience differ; check the start-up log.
   - orchestrator will not start: route registry invalid; read the logged `PSO_*` codes.
   - `pso dev` port in use / dependencies missing: free the port / `--install`.
   - 504 from a route: the upstream service is not running.
4. Re-run `pso validate`, `pso routes:list`, `pso security:check`.

Diagnostic codes of this version:

{{facts:diagnostics}}
