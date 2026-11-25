import { existsSync, readFileSync } from "node:fs";

/** Reads a JSON object file; returns undefined when absent or not an object (callers that must report use their own diagnostics). */
export function readJsonSafe(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
