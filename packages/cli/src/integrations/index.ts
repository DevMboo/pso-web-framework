import type { IntegrationAdapter } from "./core.ts";
import { reactAdapter } from "./react.ts";

/** Registered framework adapters. `pso install:<framework> <integration>` exists for each of them; add an adapter here to add a framework. */
export const ADAPTERS: Record<string, IntegrationAdapter> = { [reactAdapter.framework]: reactAdapter };
