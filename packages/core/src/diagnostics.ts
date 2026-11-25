export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** workspace-relative, forward-slash path when applicable */
  file?: string;
  hint?: string;
}

export const diag = (severity: Severity, code: string, message: string, file?: string, hint?: string): Diagnostic => {
  const d: Diagnostic = { code, severity, message };
  if (file !== undefined) d.file = file;
  if (hint !== undefined) d.hint = hint;
  return d;
};

export const hasErrors = (ds: readonly Diagnostic[]): boolean => ds.some((d) => d.severity === "error");

/** Byte-wise comparison (locale independent) so output is identical on every machine. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic ordering: file, code, message. */
export const sortDiagnostics = (ds: Diagnostic[]): Diagnostic[] =>
  [...ds].sort((a, b) => cmp(a.file ?? "", b.file ?? "") || cmp(a.code, b.code) || cmp(a.message, b.message));

export const formatDiagnostic = (d: Diagnostic): string =>
  `${d.severity.toUpperCase().padEnd(7)} ${d.code}${d.file ? ` ${d.file}` : ""}: ${d.message}${d.hint ? `\n        hint: ${d.hint}` : ""}`;
