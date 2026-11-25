#!/usr/bin/env node
// Project-local helper of a generated FEI/MEI: `pso-frontend generate` writes .pso/generated (never edit it by hand).
import { generateProject } from "../dist/node.js";
const [cmd] = process.argv.slice(2);
if (cmd !== "generate") { console.error("usage: pso-frontend generate"); process.exit(2); }
try { const written = generateProject(process.cwd()); console.log(`generated ${written.join(", ")}`); } catch (e) { console.error(e.message); process.exit(1); }
