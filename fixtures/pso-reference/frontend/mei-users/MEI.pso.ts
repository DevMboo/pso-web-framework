import { defineMEI } from "@pso/frontend";

// A microfrontend: one business domain, built, tested and released on its own. This file is DATA (literals only).
//   - the FEI that hosts it must register it (`pso fei:register users`); the relation is validated in both directions
//   - it talks to the backend only through the orchestrator, using the `api` of usePsoContext()
export default defineMEI({
  name: "mei-users",

  host: "fei-admin",

  server: { port: 9002 },

  orchestrator: { service: "gateway" },

  expose: { module: "./src/module.tsx" },

  security: {
    inheritFromHost: true,
    scopes: ["users:read", "users:admin"],
  },
});
