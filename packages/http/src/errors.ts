import type { Diagnostic } from "@pso/core";

/** An error an action raises on purpose: `status` is the HTTP status and `message` a problem kind or the text shown to the client. */
/**
 * An error the application raises on purpose. `message` is the problem kind (a catalog kind such as "not_found" or "conflict", or a
 * short code of your own); it is exposed. `detail` (a safe sentence, never user input or an internal message) and `errors` (field
 * problems) are added to the Problem Details answer when given.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: ReadonlyArray<{ field?: string; message: string }> | undefined;
  constructor(status: number, message: string, extra: { detail?: string; errors?: ReadonlyArray<{ field?: string; message: string }> } = {}) {
    super(message); this.status = status; this.detail = extra.detail; this.errors = extra.errors;
  }
}
/** Start-up was refused: nothing is listening. `diagnostics` carries the stable codes of what was wrong. */
export class StartupError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(message: string, diagnostics: Diagnostic[]) { super(message); this.diagnostics = diagnostics; }
}

export const startupDiagnostics = (issues: Array<{ code: string; message: string }>): Diagnostic[] => issues.map((i) => ({ code: i.code, severity: "error" as const, message: i.message }));
