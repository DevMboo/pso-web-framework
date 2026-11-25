import { join } from "node:path";
import { readFileSync } from "node:fs";
import { diag, sortDiagnostics, type Diagnostic } from "./diagnostics.ts";
import { CONVENTIONS, NAME_PATTERNS } from "./conventions.ts";
import type { Discovery } from "./discovery.ts";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Validates naming, duplicates and contract metadata of a project's discovered resources. */
export function validateProject(projectRoot: string, d: Discovery): Diagnostic[] {
  const out: Diagnostic[] = [...d.diagnostics];
  const conv = CONVENTIONS[d.runtime];
  const pattern = NAME_PATTERNS[conv.nameStyle];
  const seen = new Map<string, string>();

  for (const r of d.resources) {
    if (!pattern.test(r.id)) out.push(diag("error", "PSO_BAD_NAME", `"${r.id}" is not ${conv.nameStyle}-case`, r.file));
    const prev = seen.get(r.key);
    if (prev) out.push(diag("error", "PSO_DUPLICATE_ID", `Duplicate ${r.kind} "${r.id}" (also declared in ${prev})`, r.file));
    else seen.set(r.key, r.file);
    if (r.kind === "contract") out.push(...validateContractFile(join(projectRoot, ...r.file.split("/")), r.file));
  }
  return sortDiagnostics(out);
}

/** Contract = { name, version(semver), service, operations: [{id, method, path}] } — pure data, never executed. */
export function validateContractFile(abs: string, rel: string): Diagnostic[] {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return [diag("error", "PSO_CONTRACT_INVALID_JSON", `Cannot parse contract: ${(e as Error).message}`, rel)];
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return [diag("error", "PSO_CONTRACT_SHAPE", "Contract must be a JSON object", rel)];
  const out: Diagnostic[] = [];
  for (const f of ["name", "version", "service"]) {
    if (typeof o[f] !== "string") out.push(diag("error", "PSO_CONTRACT_SHAPE", `Contract field "${f}" is required and must be a string`, rel));
  }
  if (typeof o["version"] === "string" && !SEMVER.test(o["version"])) {
    out.push(diag("error", "PSO_CONTRACT_VERSION", `Contract version "${o["version"]}" is not semver`, rel));
  }
  const ops = o["operations"];
  if (!Array.isArray(ops)) {
    out.push(diag("error", "PSO_CONTRACT_SHAPE", `Contract field "operations" must be an array`, rel));
    return out;
  }
  const ids = new Set<string>();
  for (const op of ops as Array<Record<string, unknown> | null>) {
    const ok = typeof op?.["id"] === "string" && typeof op["method"] === "string" && typeof op["path"] === "string" && op["path"].startsWith("/");
    if (!op || !ok) { out.push(diag("error", "PSO_CONTRACT_OPERATION", `Each operation needs string id, method and a path starting with "/"`, rel)); continue; }
    const id = op["id"] as string;
    if (ids.has(id)) out.push(diag("error", "PSO_CONTRACT_OPERATION", `Duplicate operation id "${id}"`, rel));
    ids.add(id);
  }
  return out;
}
