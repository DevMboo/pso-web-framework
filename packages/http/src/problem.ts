/**
 * The PSO error standard: RFC 9457 Problem Details (`application/problem+json`).
 *
 * Every framework-generated error response has the same shape in TypeScript and Java:
 *   type           stable URI reference for the problem kind (urn:pso:problem:<slug>); no network resolution is implied
 *   title          short, fixed, human-readable summary of the kind
 *   status         the HTTP status
 *   detail         fixed, safe explanation: never an exception message, a path of the host, a stack or user input
 *   instance       the request path of this occurrence (no query string)
 *   code           stable PSO error code (PSO_*) for programs
 *   correlationId  the request correlation id (also the X-Correlation-ID header)
 *   errors         optional list of { field?, message } for validation problems
 *   error          DEPRECATED legacy short code, kept as an extension member so existing clients keep working
 * Shared cross-language contract data is kept next to the tests.
 */
export interface ProblemKind { legacy: string; status: number; code: string; slug: string; title: string; detail: string }

const kind = (legacy: string, status: number, code: string, title: string, detail: string): ProblemKind => ({ legacy, status, code, slug: code.replace(/^PSO_/, "").toLowerCase().replace(/_/g, "-"), title, detail });

export const PROBLEM_CATALOG: readonly ProblemKind[] = [
  kind("bad_request", 400, "PSO_HTTP_BAD_REQUEST", "Bad request", "The request could not be understood."),
  kind("validation_failed", 400, "PSO_VALIDATION_FAILED", "Validation failed", "The request is not valid; see the errors member."),
  kind("invalid_json", 400, "PSO_HTTP_INVALID_JSON", "Malformed JSON body", "The request body is not valid JSON."),
  kind("malformed_multipart", 400, "PSO_HTTP_MALFORMED_MULTIPART", "Malformed multipart body", "The multipart/form-data body is malformed."),
  kind("request_aborted", 400, "PSO_HTTP_REQUEST_ABORTED", "Request aborted", "The client closed the request before it was complete."),
  kind("unauthorized", 401, "PSO_AUTH_UNAUTHORIZED", "Authentication required", "Valid credentials are required to access this resource."),
  kind("forbidden", 403, "PSO_AUTH_FORBIDDEN", "Access denied", "The authenticated caller is not allowed to perform this operation."),
  kind("not_found", 404, "PSO_HTTP_NOT_FOUND", "Resource not found", "No resource matches the request."),
  kind("conflict", 409, "PSO_HTTP_CONFLICT", "Conflict", "The request conflicts with the current state of the resource."),
  kind("upstream_not_found", 404, "PSO_UPSTREAM_NOT_FOUND", "Resource not found", "A resource this request depends on does not exist in an upstream service."),
  kind("upstream_conflict", 409, "PSO_UPSTREAM_CONFLICT", "Conflict", "An upstream service refused the operation because it conflicts with the current state of a resource."),
  kind("payload_too_large", 413, "PSO_HTTP_PAYLOAD_TOO_LARGE", "Request body too large", "The request body exceeds the configured limit."),
  kind("file_too_large", 413, "PSO_FILE_TOO_LARGE", "File too large", "An uploaded file exceeds the allowed size."),
  kind("method_not_allowed", 405, "PSO_HTTP_METHOD_NOT_ALLOWED", "Method not allowed", "The HTTP method is not supported for this resource."),
  kind("multipart_not_enabled", 415, "PSO_HTTP_MULTIPART_DISABLED", "Multipart not enabled", "Multipart requests are not enabled for this service."),
  kind("unsupported_media_type", 415, "PSO_HTTP_UNSUPPORTED_MEDIA_TYPE", "Unsupported media type", "The request content type is not supported; use application/json."),
  kind("header_fields_too_large", 431, "PSO_HTTP_HEADERS_TOO_LARGE", "Request headers too large", "The request headers exceed the configured limit."),
  kind("too_many_requests", 429, "PSO_RATE_LIMITED", "Too many requests", "The rate limit was exceeded; retry after the interval given in Retry-After."),
  kind("internal_error", 500, "PSO_INTERNAL_ERROR", "Internal error", "The server could not complete the request."),
  kind("upstream_policy", 500, "PSO_UPSTREAM_POLICY", "Upstream call refused by policy", "The outbound call was refused by the destination policy; nothing was sent."),
  kind("bad_gateway", 502, "PSO_UPSTREAM_BAD_GATEWAY", "Bad gateway", "An upstream service returned an invalid response."),
  kind("upstream_rejected", 502, "PSO_UPSTREAM_REJECTED", "Upstream rejected the request", "An upstream service refused a request this service made to complete the operation."),
  kind("upstream_tls", 502, "PSO_UPSTREAM_TLS", "Upstream TLS failure", "The TLS connection to an upstream service could not be established or verified."),
  kind("upstream_response_too_large", 502, "PSO_UPSTREAM_RESPONSE_TOO_LARGE", "Upstream response too large", "An upstream service returned a response larger than the configured limit."),
  kind("unknown_service", 502, "PSO_UPSTREAM_UNKNOWN_SERVICE", "Upstream not configured", "The route refers to an upstream service that is not configured."),
  kind("upstream_unavailable", 503, "PSO_UPSTREAM_UNAVAILABLE", "Upstream unavailable", "An upstream service could not be reached."),
  kind("storage_unavailable", 503, "PSO_STORAGE_UNAVAILABLE", "Storage unavailable", "The file storage backend could not complete the operation."),
  kind("server_busy", 503, "PSO_SERVER_BUSY", "Server busy", "The server is at its concurrency limit; retry shortly."),
  kind("rate_limit_unavailable", 503, "PSO_RATE_LIMIT_UNAVAILABLE", "Rate limiting unavailable", "The shared rate limit backend is unavailable and the policy is to refuse requests."),
  kind("upstream_timeout", 504, "PSO_UPSTREAM_TIMEOUT", "Upstream timeout", "An upstream service did not answer in time."),
];
const BY_LEGACY = new Map(PROBLEM_CATALOG.map((k) => [k.legacy, k]));

export interface ProblemOptions {
  /** request path of this occurrence; the query string is removed */
  instance?: string;
  correlationId: string;
  errors?: ReadonlyArray<{ field?: string; message: string }>;
  /** application-chosen safe text (only for errors the application raised deliberately via HttpError) */
  detail?: string;
}
export interface Problem {
  type: string; title: string; status: number; detail: string; instance?: string; code: string; correlationId: string;
  errors?: Array<{ field?: string; message: string }>;
  /** deprecated, see the file comment */
  error: string;
}

const statusText: Record<number, string> = { 400: "Bad request", 401: "Authentication required", 403: "Access denied", 404: "Resource not found", 409: "Conflict", 422: "Unprocessable request", 429: "Too many requests", 500: "Internal error" };

/** Builds a problem from a known kind (by legacy code) or from an application HttpError (status + message). */
export function buildProblem(status: number, legacy: string, o: ProblemOptions): Problem {
  const k = BY_LEGACY.get(legacy);
  const instance = o.instance === undefined ? undefined : o.instance.split("?")[0]!.slice(0, 512);
  const base = k
    ? { type: `urn:pso:problem:${k.slug}`, title: k.title, status: k.status, detail: o.detail ?? k.detail, code: k.code, error: k.legacy }
    // an application-raised HttpError: the status is the application's, the message is its deliberately exposed text
    : { type: `urn:pso:problem:http-${status}`, title: statusText[status] ?? `HTTP ${status}`, status, detail: o.detail ?? legacy, code: `PSO_HTTP_ERROR_${status}`, error: legacy };
  return { ...base, ...(instance ? { instance } : {}), correlationId: o.correlationId, ...(o.errors?.length ? { errors: o.errors.map((e) => ({ ...(e.field ? { field: e.field } : {}), message: e.message })) } : {}) };
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";
export const kindOf = (legacy: string): ProblemKind | undefined => BY_LEGACY.get(legacy);
