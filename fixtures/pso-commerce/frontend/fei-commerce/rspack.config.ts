import { feiConfig } from "@pso/frontend/node";

// Everything structural (Module Federation host, hashed assets, dev server, `gateway` proxy, runtime configuration) is
// generated from FEI.pso.ts and ROUTES.pso.ts by the framework. Add project-specific rspack options here if you ever need them.
export default await feiConfig(import.meta.dirname);
