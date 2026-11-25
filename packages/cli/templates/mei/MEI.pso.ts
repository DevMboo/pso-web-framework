import { defineMEI } from "@pso/frontend";

// A microfrontend: one business domain, built, tested and released on its own. This file is DATA (literals only).
//   - the FEI that hosts it must register it (`pso fei:register {{domain}}`); the relation is validated in both directions
//   - it talks to the backend only through the orchestrator, using the `api` of usePsoContext()
export default defineMEI({
  name: "{{name}}",

  host: "{{host}}",

  server: { port: {{port}} },

  orchestrator: { service: "{{orchestrator}}" },

  expose: { module: "./src/module.tsx" },

  security: {
    inheritFromHost: true,
    scopes: ["{{domain}}:read"],
  },
});
