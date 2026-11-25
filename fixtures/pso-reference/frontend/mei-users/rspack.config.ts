import { generateMeiEntry, meiConfig } from "@pso/frontend/node";

// Module Federation (the remote this MEI publishes), hashed assets, the dev server and the standalone host entry are generated from
// MEI.pso.ts and ROUTES.pso.ts by the framework.
generateMeiEntry(import.meta.dirname);
export default await meiConfig(import.meta.dirname);
