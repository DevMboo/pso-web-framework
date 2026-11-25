import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_COMMANDS } from "../src/registry.ts";
import { buildSite } from "../src/portal/build.ts";
import { tmp } from "./helpers.ts";
const d = tmp("pso-probe-"); buildSite(d, ALL_COMMANDS);
const h = readFileSync(join(d, "tutorials/crud-api.html"), "utf8");
console.log(h.length, (h.match(/class="filetree"/g) ?? []).length, (h.match(/<figure class="code k-command/g) ?? []).length, (h.match(/<figure/g) ?? []).length, (h.match(/code-evidence/g) ?? []).length);
