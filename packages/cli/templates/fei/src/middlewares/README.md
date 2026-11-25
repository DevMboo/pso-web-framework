# Navigation middleware

A file here is a middleware of this application's navigation pipeline. Create one with
`pso make:middleware <name> --service {{name}}`, then list its name in `middlewares` of `FEI.pso.ts`.

```ts
import { defineMiddleware } from "@pso/frontend";

export default defineMiddleware({
  name: "maintenance-window",
  async execute(context, next) {
    if (context.get("maintenance")) return context.deny(403, "Scheduled maintenance");
    return next();
  },
});
```

Middleware shapes what the interface shows. It is not a security boundary: anything it denies is still reachable by someone using the
browser's developer tools. The orchestrator enforces access to data.
