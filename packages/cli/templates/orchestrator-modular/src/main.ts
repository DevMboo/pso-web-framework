import "reflect-metadata";
import { resolve } from "node:path";
import { bootstrap, log, shutdownOnSignals, StartupError } from "@pso/http";

// The runtime activates an endpoint only if it is declared in a module's ROUTES.pso.ts, the module is valid
// (MODULE.pso.ts) and the controller action is compatible. Nothing is exposed implicitly.
bootstrap({ appDir: __dirname, workspaceFile: process.env["PSO_WORKSPACE"] ?? resolve(__dirname, "..", "..", "pso.workspace.json"), port: Number(process.env["PORT"] ?? {{port}}) })
  // SIGINT / SIGTERM: stop accepting, let running requests finish within http.shutdown.graceMs, release the dependents, exit 0.
  // The process is ended with exit code 1 only after app.shutdown.deadlineMs (grace period + cleanup time), never earlier.
  .then((app) => { shutdownOnSignals(app); })
  .catch((e: Error) => {
    log("error", "startup failed", { error: e.message, diagnostics: e instanceof StartupError ? e.diagnostics.map((d) => d.code) : undefined });
    process.exit(1);
  });
