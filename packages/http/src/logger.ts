/**
 * Orchestrator logging. One entry point, `log(level, message, context)`, two formats:
 *   pretty  human-readable, optionally coloured (default when stdout is a terminal)
 *   json    one JSON object per line, never any ANSI escape (default when stdout is a pipe, a file or CI)
 * Configuration (environment, or `logging.*` keys through PSO_CFG_logging__level etc. when the caller passes the effective environment):
 *   PSO_LOG_LEVEL   trace | debug | info | warn | error | fatal | silent   (default info)
 *   PSO_LOG_FORMAT  pretty | json                                          (default: pretty on a TTY, json otherwise)
 *   PSO_LOG_COLOR   auto | always | never                                  (default auto; NO_COLOR and FORCE_COLOR are honoured, CI disables colour)
 * Secrets never reach the output: values of sensitive keys, bearer tokens, JWTs and credentials inside URLs are replaced before formatting.
 */
export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
const ORDER: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVELS = Object.keys(ORDER) as Level[];

export interface LogConfig { level: Level | "silent"; format: "pretty" | "json"; color: boolean; stack: boolean }
export class LogConfigError extends Error {}

type Env = Record<string, string | undefined>;
export function loadLogConfig(env: Env = process.env, tty: boolean = process.stdout.isTTY === true): LogConfig {
  const level = (env["PSO_LOG_LEVEL"] ?? "info").toLowerCase();
  if (level !== "silent" && !LEVELS.includes(level as Level)) throw new LogConfigError(`PSO_LOG_LEVEL must be one of: ${[...LEVELS, "silent"].join(", ")} (got "${level.slice(0, 20)}")`);
  const fmt = (env["PSO_LOG_FORMAT"] ?? (tty ? "pretty" : "json")).toLowerCase();
  if (fmt !== "pretty" && fmt !== "json") throw new LogConfigError('PSO_LOG_FORMAT must be "pretty" or "json"');
  const colorMode = (env["PSO_LOG_COLOR"] ?? "auto").toLowerCase().replace(/^detect$/, "auto"); // "detect" is the Spring spelling of the same choice
  if (!["auto", "always", "never"].includes(colorMode)) throw new LogConfigError('PSO_LOG_COLOR must be "auto", "always" or "never"');
  let color: boolean;
  if (fmt === "json" || colorMode === "never") color = false;
  else if (colorMode === "always") color = true;
  else if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") color = false; // https://no-color.org
  else if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "") color = env["FORCE_COLOR"] !== "0" && env["FORCE_COLOR"] !== "false"; // FORCE_COLOR=0 turns colour off, any other value forces it
  else color = tty && env["CI"] === undefined && env["TERM"] !== "dumb";
  return { level: level as Level | "silent", format: fmt as "pretty" | "json", color, stack: ORDER[(level === "silent" ? "fatal" : level) as Level] <= ORDER.debug };
}

// ---------------------------------------------------------------- redaction
const SENSITIVE_KEY = /(authorization|cookie|passw(or)?d|passphrase|secret|token|api[-_]?key|private[-_]?key|credential|jwt|bearer|session|signature)/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const PAIR = /\b(password|passwd|secret|token|api[-_]?key)=([^\s&;,]+)/gi;
export const REDACTED = "[REDACTED]";

export function redactString(s: string): string {
  return s.replace(JWT, REDACTED).replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`).replace(URL_CREDS, `$1${REDACTED}@`).replace(PAIR, (_m, k: string) => `${k}=${REDACTED}`);
}
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[nested]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) return errorFields(value, false, depth, seen);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1, seen);
  return out;
}
function errorFields(e: Error, stack: boolean, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: e.name, message: redactString(e.message) };
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") out["code"] = code;
  if (stack && e.stack) out["stack"] = redactString(e.stack).split("\n").slice(1, 9).map((l) => l.trim());
  if (e.cause !== undefined && depth < 3) out["cause"] = redact(e.cause, depth + 1, seen);
  return out;
}

// ---------------------------------------------------------------- formatting
const RESET = "\u001b[0m", DIM = "\u001b[2m";
const COLORS: Record<Level, string> = { trace: "\u001b[90m", debug: "\u001b[36m", info: "\u001b[32m", warn: "\u001b[33m", error: "\u001b[31m", fatal: "\u001b[1;97;41m" };
const LABEL: Record<Level, string> = { trace: "TRACE", debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR", fatal: "FATAL" };

function flat(v: unknown): string {
  if (typeof v === "string") return /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

export function formatLine(cfg: LogConfig, level: Level, msg: string, ctx: Record<string, unknown>, now: Date = new Date()): string {
  const safeMsg = redactString(msg);
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v instanceof Error) safe[k] = errorFields(v, cfg.stack, 0, new WeakSet());
    else safe[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v);
  }
  if (cfg.format === "json") return JSON.stringify({ ts: now.toISOString(), level, msg: safeMsg, ...safe });
  const { component, correlationId, requestId, ...rest } = safe;
  const time = now.toISOString().replace("T", " ").replace("Z", "");
  const c = (code: string, text: string): string => (cfg.color ? `${code}${text}${RESET}` : text);
  const head = `${c(DIM, time)} ${c(COLORS[level], LABEL[level])}`;
  const where = typeof component === "string" ? ` ${c(DIM, `[${component}]`)}` : "";
  const ids = [correlationId, requestId].filter((x): x is string => typeof x === "string").map((x) => c(DIM, `(${x})`)).join(" ");
  const tail = Object.entries(rest).map(([k, v]) => `${c(DIM, k + "=")}${flat(v)}`).join(" ");
  const text = level === "fatal" || level === "error" ? c(COLORS[level], safeMsg) : safeMsg;
  const stack = (rest["error"] as { stack?: string[] } | undefined)?.stack;
  const trace = stack ? `\n${stack.map((l) => `    ${c(DIM, l)}`).join("\n")}` : "";
  return `${head}${where} ${text}${ids ? " " + ids : ""}${tail ? "  " + tail : ""}${trace}`;
}

// ---------------------------------------------------------------- the process-wide logger
let current: LogConfig | undefined;
let sink: (line: string) => void = (line) => { process.stdout.write(line + "\n"); };
/** (Re)reads the configuration from the environment; invalid values stop start-up through the thrown LogConfigError. */
export function configureLogging(env: Env = process.env, tty?: boolean): LogConfig { current = loadLogConfig(env, tty); return current; }
/** test hook: redirect the output */
export function setLogSink(f: (line: string) => void): void { sink = f; }
export function resetLogging(): void { current = undefined; sink = (line) => { process.stdout.write(line + "\n"); }; }

export function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const cfg = (current ??= (() => { try { return loadLogConfig(); } catch { return loadLogConfig({}); } })()); // a bad variable is reported by configureLogging at start-up, never here
  if (cfg.level === "silent") return;
  const lv = (LEVELS.includes(level as Level) ? level : level === "warning" ? "warn" : "info") as Level;
  if (ORDER[lv] < ORDER[cfg.level]) return;
  sink(formatLine(cfg, lv, msg, extra));
}
export const enabled = (level: Level): boolean => { const cfg = current ?? loadLogConfig({}); return cfg.level !== "silent" && ORDER[level] >= ORDER[cfg.level]; };
