import { WORKSPACE, FRAMEWORK } from "./config.mjs";
import { spawnSync } from "node:child_process"; import { randomBytes } from "node:crypto";
const o = spawnSync(process.execPath, [`${FRAMEWORK}/packages/cli/bin/pso.js`, "environment:secret", "shop-customers", "channels-bus-secret"], { input: randomBytes(32).toString("hex"), encoding: "utf8", cwd: `${WORKSPACE}` });
console.log("channels-bus-secret", o.status === 0 ? "stored" : "FAILED " + o.stderr.split("\n")[0]);
