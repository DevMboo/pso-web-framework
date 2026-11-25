import { spawnSync } from "node:child_process";
import { redactText } from "../redact.ts";

/**
 * Optional Java (Maven / Spring Boot) dependency scanning.
 *
 * PSO does NOT implement a vulnerability database or a matching engine: it runs OSV-Scanner (an established, maintained, free tool that reads
 * pom.xml files and jar archives and asks the OSV database). The adapter only (1) detects whether the tool exists, (2) runs it with a timeout and
 * a fixed argv (no shell), (3) turns its JSON into a severity count, and (4) reports honestly when it could NOT run: not installed, no network
 * for the database, timed out, unreadable output. A scan that did not run is `unavailable`, never `passed`, and no result is ever invented.
 *
 * Database freshness: OSV-Scanner queries the live OSV API, so the "database" is as fresh as the request; the report states the moment and the
 * source. When the tool is run in an offline mode the report cannot claim freshness and says so.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "unknown";
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

export interface Finding { id: string; package: string; version: string; severity: Severity; summary: string }
export interface ScanReport {
  tool: string; version?: string;
  /** passed: ran, nothing at or above the block severity. failed: ran, found. unavailable: could not run (see note). */
  status: "passed" | "failed" | "unavailable";
  findings: Finding[]; counts: Record<Severity, number>; packages?: number;
  database?: { source: string; queriedAt: string; note: string };
  durationMs: number; note: string;
}
const emptyCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
const unavailable = (tool: string, note: string, durationMs = 0): ScanReport => ({ tool, status: "unavailable", findings: [], counts: emptyCounts(), durationMs, note });

export interface Exec { (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }): { status: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean } }
export const realExec: Exec = (cmd, args, o) => {
  const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: "utf8", timeout: o.timeoutMs, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), ...(r.error ? { error: r.error.message, timedOut: (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" } : {}) };
};

const scoreToSeverity = (score: number | undefined): Severity => (score === undefined || Number.isNaN(score) ? "unknown" : score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "unknown");
const wordToSeverity = (s: string | undefined): Severity => { const v = (s ?? "").toLowerCase(); return v === "critical" ? "critical" : v === "high" ? "high" : v === "moderate" || v === "medium" ? "medium" : v === "low" ? "low" : "unknown"; };

interface OsvJson { results?: Array<{ packages?: Array<{ package?: { name?: string; version?: string }; vulnerabilities?: Array<{ id?: string; summary?: string; database_specific?: { severity?: string }; severity?: Array<{ score?: string }> }>; groups?: Array<{ ids?: string[]; max_severity?: string }> }> }> }

/** Parses OSV-Scanner's `--format json` output. Exported for tests. */
export function parseOsv(json: string): { findings: Finding[]; packages: number } {
  const doc = JSON.parse(json) as OsvJson; const findings: Finding[] = []; let packages = 0; const seen = new Set<string>();
  for (const r of doc.results ?? []) for (const p of r.packages ?? []) {
    packages++;
    const groupScore = new Map<string, number>(); for (const g of p.groups ?? []) for (const id of g.ids ?? []) { const n = Number(g.max_severity); if (g.max_severity && Number.isFinite(n) && n > 0) groupScore.set(id, n); } // an empty score means "none published", not zero
    for (const v of p.vulnerabilities ?? []) {
      const id = v.id ?? "unknown"; const key = `${p.package?.name}@${p.package?.version}#${id}`; if (seen.has(key)) continue; seen.add(key);
      const sev = groupScore.has(id) ? scoreToSeverity(groupScore.get(id)) : wordToSeverity(v.database_specific?.severity);
      findings.push({ id, package: p.package?.name ?? "?", version: p.package?.version ?? "?", severity: sev, summary: redactText((v.summary ?? "").slice(0, 160)) });
    }
  }
  return { findings, packages };
}

export function detectScanner(exec: Exec = realExec, bin = process.env["PSO_OSV_SCANNER"] ?? "osv-scanner"): { available: boolean; bin: string; version?: string; reason?: string } {
  const r = exec(bin, ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
  if (r.error || r.status !== 0) return { available: false, bin, reason: `${bin} is not installed or not executable on this server` };
  return { available: true, bin, version: /(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr)?.[1] };
}

/** Scans a directory (a release's service directory: pom.xml files and/or jars). */
export function scanJava(dir: string, o: { blockSeverity: Severity | "none"; timeoutMs?: number; exec?: Exec; bin?: string; now?: () => Date } = { blockSeverity: "none" }): ScanReport {
  const exec = o.exec ?? realExec; const t0 = Date.now(); const timeoutMs = o.timeoutMs ?? 120_000;
  const d = detectScanner(exec, o.bin);
  if (!d.available) return unavailable("osv-scanner", `${d.reason}. Install OSV-Scanner (https://google.github.io/osv-scanner/) on the server or in the build environment; Java dependencies were NOT scanned`);
  const r = exec(d.bin, ["scan", "--format", "json", "--recursive", dir], { cwd: dir, timeoutMs });
  const ms = Date.now() - t0;
  if (r.timedOut) return { ...unavailable("osv-scanner", `the scan exceeded ${Math.round(timeoutMs / 1000)}s and was stopped: Java dependencies were NOT scanned`, ms), ...(d.version ? { version: d.version } : {}) };
  // osv-scanner exits 1 when it FOUND vulnerabilities (valid output), 128 when there was nothing to scan, anything else is a failure to run
  const hasJson = /^\s*\{/.test(r.stdout);
  if (r.error || (r.status !== 0 && r.status !== 1) || !hasJson) {
    const why = r.status === 128 ? "nothing it can scan was found (no pom.xml, no jar)" : redactText(`${r.stderr}`.trim().split("\n").slice(-2).join(" ").slice(0, 240)) || `exit ${r.status}`;
    const net = /(dial tcp|no such host|network|timeout|connection refused|lookup|tls)/i.test(r.stderr);
    return { ...unavailable("osv-scanner", `${net ? "the vulnerability database (osv.dev) could not be reached from this server: " : ""}${why}. Java dependencies were NOT scanned`, ms), ...(d.version ? { version: d.version } : {}) };
  }
  let parsed: { findings: Finding[]; packages: number };
  try { parsed = parseOsv(r.stdout); } catch { return { ...unavailable("osv-scanner", "its output could not be read: Java dependencies were NOT scanned", ms), ...(d.version ? { version: d.version } : {}) }; }
  const counts = emptyCounts(); for (const f of parsed.findings) counts[f.severity]++;
  const limit = o.blockSeverity === "none" ? Infinity : SEVERITY_RANK[o.blockSeverity];
  const blocking = parsed.findings.filter((f) => SEVERITY_RANK[f.severity] >= limit);
  const queriedAt = (o.now?.() ?? new Date()).toISOString();
  return {
    tool: "osv-scanner", ...(d.version ? { version: d.version } : {}), status: blocking.length ? "failed" : "passed", findings: parsed.findings.slice(0, 200), counts, packages: parsed.packages,
    database: { source: "osv.dev (queried live by osv-scanner)", queriedAt, note: "freshness is that of the OSV service at the time of the request; this server keeps no local copy" }, durationMs: ms,
    note: `${parsed.packages} package(s) inventoried; ${parsed.findings.length} advisory(ies): ${JSON.stringify(counts)}${o.blockSeverity === "none" ? " (report only: no severity blocks)" : `; blocking severity ${o.blockSeverity} or higher: ${blocking.length}`}`,
  };
}
