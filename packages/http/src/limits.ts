/**
 * Framework-managed HTTP limits for the orchestrator. Every value is validated at start-up; an invalid value stops the process with
 * a message naming the variable. Production (NODE_ENV=production) refuses to run with the critical safeguards switched off.
 */
export interface HttpLimits {
  /** maximum request body (bytes) */
  maxBodyBytes: number;
  /** maximum response body accepted from an upstream service (bytes) */
  maxUpstreamResponseBytes: number;
  /** maximum size of the request line plus headers (bytes) */
  maxHeaderBytes: number;
  /** time to connect to an upstream and the idle time of an upstream socket (ms) */
  upstreamTimeoutMs: number;
  /** deadline for the whole upstream exchange (ms) */
  upstreamResponseTimeoutMs: number;
  /** time a client has to send the complete headers (ms) */
  headersTimeoutMs: number;
  /** time a client has to send the complete request (ms) */
  requestTimeoutMs: number;
  /** idle time of a keep-alive connection (ms) */
  keepAliveTimeoutMs: number;
  /** maximum open connections */
  maxConnections: number;
  /** maximum requests being processed at once; 0 = unlimited */
  maxConcurrentRequests: number;
  /** maximum size of a whole multipart/form-data request (bytes), counted while it streams; a DTO's own file limits apply inside it */
  maxUploadBytes: number;
  /** maximum parts (fields and files) of one multipart request */
  maxMultipartParts: number;
  /** maximum multipart uploads being received at once; 0 = unlimited */
  maxConcurrentUploads: number;
}

interface Spec { env: string; key: keyof HttpLimits; def: number; min: number; max: number; critical: boolean }
const SPECS: readonly Spec[] = [
  { env: "MAX_BODY_BYTES", key: "maxBodyBytes", def: 1_048_576, min: 1, max: 1_073_741_824, critical: true },
  { env: "MAX_UPSTREAM_RESPONSE_BYTES", key: "maxUpstreamResponseBytes", def: 10_485_760, min: 1, max: 1_073_741_824, critical: true },
  { env: "MAX_HEADER_BYTES", key: "maxHeaderBytes", def: 16_384, min: 1024, max: 1_048_576, critical: true },
  { env: "UPSTREAM_TIMEOUT_MS", key: "upstreamTimeoutMs", def: 5000, min: 1, max: 600_000, critical: true },
  { env: "UPSTREAM_RESPONSE_TIMEOUT_MS", key: "upstreamResponseTimeoutMs", def: 30_000, min: 1, max: 3_600_000, critical: true },
  { env: "HEADERS_TIMEOUT_MS", key: "headersTimeoutMs", def: 10_000, min: 1, max: 600_000, critical: true },
  { env: "REQUEST_TIMEOUT_MS", key: "requestTimeoutMs", def: 30_000, min: 1, max: 3_600_000, critical: true },
  { env: "KEEP_ALIVE_TIMEOUT_MS", key: "keepAliveTimeoutMs", def: 5000, min: 1, max: 600_000, critical: false },
  { env: "MAX_CONNECTIONS", key: "maxConnections", def: 1000, min: 1, max: 1_000_000, critical: true },
  { env: "MAX_CONCURRENT_REQUESTS", key: "maxConcurrentRequests", def: 0, min: 0, max: 1_000_000, critical: false },
  { env: "MAX_UPLOAD_BYTES", key: "maxUploadBytes", def: 10_485_760, min: 1, max: 5_368_709_120, critical: true },
  { env: "MAX_MULTIPART_PARTS", key: "maxMultipartParts", def: 50, min: 1, max: 1000, critical: true },
  { env: "MAX_CONCURRENT_UPLOADS", key: "maxConcurrentUploads", def: 16, min: 0, max: 100_000, critical: false },
];

export class HttpLimitsError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid HTTP limits:\n - ${problems.join("\n - ")}`);
    this.name = "HttpLimitsError";
    this.problems = problems;
  }
}

/** Parses the limits from the environment. Throws HttpLimitsError listing every problem. */
export function loadHttpLimits(env: NodeJS.ProcessEnv = process.env): HttpLimits {
  const out = {} as Record<keyof HttpLimits, number>;
  const problems: string[] = [];
  for (const s of SPECS) {
    const raw = env[s.env];
    if (raw === undefined || raw.trim() === "") { out[s.key] = s.def; continue; }
    if (!/^\d+$/.test(raw.trim())) { problems.push(`${s.env} must be a whole number (got a non-numeric value)`); continue; }
    const n = Number(raw.trim());
    if (n < s.min || n > s.max) { problems.push(`${s.env} must be between ${s.min} and ${s.max} (got ${n})`); continue; }
    out[s.key] = n;
  }
  if (!problems.length) {
    if (out.headersTimeoutMs > out.requestTimeoutMs) problems.push("HEADERS_TIMEOUT_MS must not exceed REQUEST_TIMEOUT_MS");
    if (env["NODE_ENV"] === "production") {
      // the defaults are safe; production only forbids moving the critical limits to values that defeat them
      for (const s of SPECS) if (s.critical && s.key !== "maxConnections" && out[s.key] > s.def * 100) problems.push(`${s.env}=${out[s.key]} is more than 100 times the safe default (${s.def}); production does not allow effectively disabling this safeguard`);
    }
  }
  if (problems.length) throw new HttpLimitsError(problems);
  return out;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = loadHttpLimits({});
