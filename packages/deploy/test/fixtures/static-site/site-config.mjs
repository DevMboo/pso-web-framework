// Runs INSIDE the container: the runtime configuration of the site, written with the same primitive `pso frontend:config` uses.
import { readFileSync } from "node:fs";
import { writeRuntimeConfig } from "/app/node_modules/@pso/frontend/dist/release.js";
const o = JSON.parse(readFileSync("/fixture-run/site-config.json", "utf8"));
const cfg = writeRuntimeConfig({ site: o.site, fei: o.fei, auth: o.auth, orchestratorBasePath: o.api, ...(o.channels ? { channelsPath: o.channels } : {}), meis: o.meis, ...(o.requireSignature ? { requireSignature: true } : {}), ...(o.trustedKeys ? { trustedKeys: o.trustedKeys } : {}) });
console.log("CONFIG " + JSON.stringify({ remotes: Object.keys(cfg.remotes), requireSignature: cfg.requireSignature ?? false }));
