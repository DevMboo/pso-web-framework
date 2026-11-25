/** Reasons are for logs and metrics only. They are never sent to HTTP clients (clients get a bare 401). */
export type AuthFailure =
  | "missing_header" | "malformed_header" | "token_too_large" | "malformed_token" | "bad_algorithm" | "forbidden_header"
  | "bad_signature" | "expired" | "not_yet_valid" | "bad_issuer" | "bad_audience" | "missing_claim" | "invalid_subject"
  | "unknown_key" | "key_unavailable" | "invalid";

export interface ConfigIssue { code: string; message: string; key?: string }

/** Raised before the HTTP server starts. Messages name the key, never a secret value. */
export class SecurityConfigError extends Error {
  readonly code = "PSO_SEC_CONFIG";
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(`invalid security configuration:\n${issues.map((i) => ` - ${i.code}${i.key ? ` (${i.key})` : ""}: ${i.message}`).join("\n")}`);
    this.issues = issues;
  }
}

/** Raised when a key provider cannot be initialized (after controlled retries for transient causes). */
export class SecurityInitError extends Error {
  readonly code = "PSO_SEC_INIT";
  readonly transient: boolean;
  constructor(message: string, transient: boolean) { super(message); this.transient = transient; }
}

/** The key source cannot currently provide keys (network down, stale beyond limit). Distinct from an invalid token. */
export class KeyUnavailableError extends Error {
  readonly code = "PSO_SEC_KEY_UNAVAILABLE";
  constructor(message: string) { super(message); }
}

/** A JWKS fetch failure with a stable, non-sensitive classification. */
export class JwksFetchError extends Error {
  readonly code: string;
  readonly transient: boolean;
  constructor(code: string, message: string, transient: boolean) { super(message); this.code = code; this.transient = transient; }
}
