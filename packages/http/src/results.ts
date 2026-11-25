/**
 * Explicit action results, for the answers the default (200, or 201 for POST, with the returned value as JSON) cannot express:
 *
 *   return created(product, `/products/${product.id}`);   // 201 + Location
 *   return noContent();                                   // 204, no body
 *   return withStatus(202, { jobId });                    // any 2xx/3xx status
 *
 * Only response metadata is set here; errors are thrown (HttpError, or an UpstreamCallError left unhandled) and become Problem Details.
 */
const RESULT = Symbol.for("pso.http.result");

export interface ActionResult {
  readonly [RESULT]: true;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/** Headers an action may set through a result. Framing, security and correlation headers are the framework's. */
const ALLOWED = new Set(["location", "etag", "last-modified", "content-location", "cache-control", "retry-after"]);
const SAFE_VALUE = /^[\x20-\x7e]*$/;

export function withStatus(status: number, body?: unknown, headers: Readonly<Record<string, string>> = {}): ActionResult {
  if (!Number.isInteger(status) || status < 200 || status > 399) throw new Error(`withStatus: ${status} is not a success or redirect status; throw an HttpError for errors`);
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (!ALLOWED.has(name)) throw new Error(`withStatus: the header "${k}" cannot be set by an action (allowed: ${[...ALLOWED].join(", ")})`);
    if (typeof v !== "string" || !SAFE_VALUE.test(v)) throw new Error(`withStatus: the value of "${k}" must be printable ASCII`);
    h[name] = v;
  }
  return { [RESULT]: true, status, body: status === 204 || status === 304 ? undefined : body, headers: h };
}

/** 201 Created with the new resource and, when given, its Location (a path or an absolute URL). */
export const created = (body: unknown, location?: string): ActionResult => withStatus(201, body, location ? { location } : {});

/** 204 No Content: the operation succeeded and there is nothing to return. */
export const noContent = (): ActionResult => withStatus(204);

export const isActionResult = (v: unknown): v is ActionResult => typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[RESULT] === true;
