#!/usr/bin/env node
// Installation maintenance (setup, integrity, repair, update, uninstall) runs through its own small entry point, so that a damaged
// file of any other part of PSO cannot stop the commands that detect and repair it.
const MAINTENANCE = new Set(["setup", "integrity", "repair", "update", "uninstall"]);
const argv = process.argv.slice(2);
const maintenance = MAINTENANCE.has(argv.find((a) => !a.startsWith("-"))) && !argv.includes("--help");
const run = maintenance ? (await import("../dist/maintenance.js")).runMaintenance : (await import("../dist/main.js")).run;

run(argv, process.cwd(), (s) => console.log(s), (s) => console.error(s))
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(`internal error: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 70; });
