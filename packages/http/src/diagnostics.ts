import { redactString } from "./logger.ts";

/**
 * What the log records about an error nobody handled.
 *
 * Always (safe in every environment): the error type, a stable `code` when the error carries one, and `origin`, the first place in
 * the application's own code on the stack (file:line:column, no message). Together with the route, the controller action and the
 * correlation id that the caller adds, this is enough to find the failing line from a production log.
 *
 * With `details` (development and test): also the message, the stack and the chain of causes. They pass through the logger's
 * redaction (bearer tokens, JWTs, credentials in URLs, key=value secrets), but a message may still quote request data, so production
 * does not record them. Nothing here is ever sent to the HTTP client.
 */
export function describeError(err: unknown, details: boolean): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: "non-error value thrown", ...(details ? { value: typeof err === "string" ? redactString(err.slice(0, 500)) : typeof err } : {}) };
  const out: Record<string, unknown> = { error: err.name || "Error" };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(code)) out["code"] = code;
  const frames = stackFrames(err);
  const origin = frames.find((f) => !/[\\/]node_modules[\\/]|^node:|\(node:|[\\/]@pso[\\/]|[\\/]packages[\\/](http|core|security|dispatch|channels)[\\/]/.test(f)) ?? frames[0];
  if (origin) out["origin"] = locationOf(origin);
  if (!details) return out;
  out["message"] = redactString(err.message.slice(0, 2000));
  if (frames.length) out["stack"] = frames.slice(0, 12).map((f) => redactString(f));
  const causes: string[] = [];
  for (let c: unknown = err.cause, i = 0; c !== undefined && i < 4; c = (c as { cause?: unknown })?.cause, i++) causes.push(c instanceof Error ? `${c.name}: ${redactString(c.message.slice(0, 500))}` : typeof c);
  if (causes.length) out["causes"] = causes;
  return out;
}

const stackFrames = (e: Error): string[] => (e.stack ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
/** "at Class.method (file:line:col)" -> "Class.method (file:line:col)": where, never what. */
const locationOf = (frame: string): string => frame.replace(/^at\s+/, "").slice(0, 300);

/**
 * A start-up failure of an optional subsystem (dispatch) as structured fields. Configuration errors of @pso/dispatch carry every
 * problem (`problems`, or one per line of the message); only the first line used to be reported, which hid the properties at fault.
 * Values are not part of these messages, and what looks like a credential is redacted anyway.
 */
export function startupProblems(e: unknown): { code: string | undefined; summary: string; problems: string[]; text: string; issues: Array<{ code: string; key?: string; message: string }> } {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = typeof (err as { code?: unknown }).code === "string" ? (err as unknown as { code: string }).code : undefined;
  const lines = err.message.split(/\r?\n/).map((l) => redactString(l.trimEnd())).filter((l) => l.trim() !== "");
  // @pso/dispatch reports configuration problems as { code, key, message }: the property at fault is a field of its own
  const issues = (Array.isArray((err as { issues?: unknown }).issues) ? (err as unknown as { issues: unknown[] }).issues : [])
    .filter((i): i is { code: string; key?: string; message: string } => typeof i === "object" && i !== null && typeof (i as { code?: unknown }).code === "string" && typeof (i as { message?: unknown }).message === "string")
    .map((i) => ({ code: i.code, ...(typeof i.key === "string" ? { key: i.key } : {}), message: redactString(i.message) }));
  const listed = issues.length ? issues.map((i) => `${i.code}${i.key ? ` (${i.key})` : ""}: ${i.message}`)
    : Array.isArray((err as { problems?: unknown }).problems) ? ((err as unknown as { problems: unknown[] }).problems).filter((p): p is string => typeof p === "string").map((p) => redactString(p)) : [];
  const summary = lines[0] ?? err.name;
  const rest = lines.slice(1).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const problems = listed.length ? listed : rest.length ? rest : [summary];
  const text = listed.length || rest.length ? `${summary}\n - ${problems.join("\n - ")}` : summary;
  return { code, summary: summary.replace(/:$/, ""), problems, text, issues };
}
