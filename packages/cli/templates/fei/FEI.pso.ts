import { defineFEI } from "@pso/frontend";

// The application shell. This file is DATA (it is read, never executed): literals only.
//   - register microfrontends with `pso fei:register <name>`
//   - the orchestrator is the only backend this application (and its microfrontends) may call
export default defineFEI({
  name: "{{name}}",

  server: { port: {{port}} },

  orchestrator: { service: "{{orchestrator}}", basePath: "/api" },

  security: { authentication: "jwt", session: "centralized", loginPath: "/login" },

  // navigation pipeline, in execution order. "authentication" and "authorization" are mandatory while authentication is "jwt".
  // Add your own with `pso make:middleware <name> --service {{name}}` and list its name here.
  middlewares: ["authentication", "authorization", "session", "context", "telemetry"],

  locale: { default: "en", supported: ["en"] },

  microfrontends: [],
});
