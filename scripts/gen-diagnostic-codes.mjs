#!/usr/bin/env node
// Writes packages/cli/diagnostic-codes.json: the stable diagnostic codes and their messages, extracted from the compiled framework sources.
// A distribution ships this file because a protected (bundled, minified) build cannot be scanned for codes and must not disclose module names.
// Part of `npm run build`; it always scans (it never reads a previous output, so the file cannot go stale).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { scanDiagnosticCodes } = await import(pathToFileURL(resolve(root, "packages", "cli", "dist", "portal", "build.js")).href);
const codes = scanDiagnosticCodes().map(({ code, message }) => ({ code, message })).sort((a, b) => (a.code < b.code ? -1 : 1));
if (codes.length < 50) { console.error(`only ${codes.length} diagnostic codes were found: the compiled sources were not scanned correctly`); process.exit(1); }
writeFileSync(resolve(root, "packages", "cli", "diagnostic-codes.json"), JSON.stringify({ schema: 1, codes }, null, 1) + "\n");
console.log(`diagnostic codes: ${codes.length} -> packages/cli/diagnostic-codes.json`);
