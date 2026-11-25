import { randomUUID } from "node:crypto";

/** Stable error with a code; messages never contain payloads or credentials. */
export class DispatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "DispatchError";
  }
}

/**
 * The canonical wire contract, identical in TypeScript and Java (pso.dispatch envelope, version 1).
 * Serialized as UTF-8 JSON in canonical form: envelope fields in a fixed order, payload keys sorted. No class or type names
 * of either runtime ever appear on the wire.
 */
export interface DispatchEnvelope {
  envelopeVersion: 1;
  id: string;
  type: string;
  /** schema version of the event type's payload */
  version: number;
  source: string;
  /** RFC 3339, UTC, millisecond precision, for example 2026-11-07T12:00:00.000Z */
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  trace?: { traceparent: string; tracestate?: string };
  contentType: "application/json";
  payload: unknown;
}

export const LIMITS = { maxBytes: 1_048_576, maxMetaLength: 256, maxPayloadDepth: 32 } as const;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TYPE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const SOURCE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const FIELDS = ["envelopeVersion", "id", "type", "version", "source", "occurredAt", "correlationId", "causationId", "trace", "contentType", "payload"];

export const isEventName = (s: string): boolean => TYPE.test(s);
export const isChannelName = (s: string): boolean => /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/.test(s) && s.length <= 100;

function depth(v: unknown, d = 0): number {
  if (d > LIMITS.maxPayloadDepth) return d;
  if (Array.isArray(v)) return v.reduce((m: number, x) => Math.max(m, depth(x, d + 1)), d);
  if (v && typeof v === "object") return Object.values(v).reduce((m: number, x) => Math.max(m, depth(x, d + 1)), d);
  return d;
}

/** @returns the list of problems (empty when valid). Unknown top-level fields are rejected: metadata can never smuggle extra data. */
export function envelopeProblems(e: unknown): string[] {
  const p: string[] = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["envelope must be a JSON object"];
  const o = e as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) p.push(`unknown field "${k}"`);
  if (o["envelopeVersion"] !== 1) p.push("envelopeVersion must be 1");
  const str = (k: string, re: RegExp, required = true) => {
    const v = o[k];
    if (v === undefined) { if (required) p.push(`${k} is required`); return; }
    if (typeof v !== "string" || v.length > LIMITS.maxMetaLength || !re.test(v)) p.push(`${k} is invalid`);
  };
  str("id", ID); str("type", TYPE); str("source", SOURCE); str("occurredAt", TIME); str("correlationId", ID); str("causationId", ID, false);
  if (!Number.isInteger(o["version"]) || (o["version"] as number) < 1) p.push("version must be an integer >= 1");
  if (o["contentType"] !== "application/json") p.push("contentType must be application/json");
  if (!("payload" in o)) p.push("payload is required");
  else if (depth(o["payload"]) > LIMITS.maxPayloadDepth) p.push("payload is nested too deeply");
  if (o["trace"] !== undefined) {
    const t = o["trace"] as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) p.push("trace must be an object");
    else {
      for (const k of Object.keys(t)) if (k !== "traceparent" && k !== "tracestate") p.push(`unknown trace field "${k}"`);
      if (typeof t["traceparent"] !== "string" || !TRACEPARENT.test(t["traceparent"])) p.push("trace.traceparent is invalid");
      if (t["tracestate"] !== undefined && (typeof t["tracestate"] !== "string" || t["tracestate"].length > 512)) p.push("trace.tracestate is invalid");
    }
  }
  return p;
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}

/** Canonical JSON: the same bytes from TypeScript and Java for the same envelope (payload numbers must be integers or exact decimals). */
export function serializeEnvelope(e: DispatchEnvelope): string {
  const bad = envelopeProblems(e);
  if (bad.length) throw new DispatchError("PSO_DISPATCH_ENVELOPE_INVALID", `invalid envelope: ${bad.join("; ")}`);
  const ordered: Record<string, unknown> = {};
  for (const k of FIELDS) if ((e as unknown as Record<string, unknown>)[k] !== undefined) ordered[k] = k === "payload" ? canon(e.payload) : (e as unknown as Record<string, unknown>)[k];
  if (e.trace) ordered["trace"] = { traceparent: e.trace.traceparent, ...(e.trace.tracestate !== undefined ? { tracestate: e.trace.tracestate } : {}) };
  const text = JSON.stringify(ordered);
  if (Buffer.byteLength(text) > LIMITS.maxBytes) throw new DispatchError("PSO_DISPATCH_ENVELOPE_TOO_LARGE", `envelope exceeds ${LIMITS.maxBytes} bytes`);
  return text;
}

/** Parses untrusted bytes. Only plain JSON data is produced (no prototypes, no class instantiation). */
export function parseEnvelope(raw: string | Buffer, maxBytes: number = LIMITS.maxBytes): DispatchEnvelope {
  const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (size > maxBytes) throw new DispatchError("PSO_DISPATCH_ENVELOPE_TOO_LARGE", `message exceeds ${maxBytes} bytes`);
  let v: unknown;
  try { v = JSON.parse(raw.toString(), (k, x) => (k === "__proto__" ? undefined : x)); } catch { throw new DispatchError("PSO_DISPATCH_ENVELOPE_INVALID", "message is not valid JSON"); }
  const bad = envelopeProblems(v);
  if (bad.length) throw new DispatchError("PSO_DISPATCH_ENVELOPE_INVALID", `invalid envelope: ${bad.join("; ")}`);
  return v as DispatchEnvelope;
}

export interface NewEnvelope { type: string; version: number; source: string; payload: unknown; correlationId?: string; causationId?: string; trace?: DispatchEnvelope["trace"]; id?: string; now?: () => Date }

export function createEnvelope(o: NewEnvelope): DispatchEnvelope {
  const e: DispatchEnvelope = {
    envelopeVersion: 1, id: o.id ?? randomUUID(), type: o.type, version: o.version, source: o.source,
    occurredAt: (o.now ?? (() => new Date()))().toISOString(), correlationId: o.correlationId ?? randomUUID(),
    ...(o.causationId ? { causationId: o.causationId } : {}), ...(o.trace ? { trace: o.trace } : {}), contentType: "application/json", payload: o.payload,
  };
  const bad = envelopeProblems(e);
  if (bad.length) throw new DispatchError("PSO_DISPATCH_ENVELOPE_INVALID", `invalid envelope: ${bad.join("; ")}`);
  return e;
}
