/**
 * PSO Channels wire protocol, version 1. JSON text frames over WebSocket (subprotocol `pso.channels.v1`).
 *
 * Client -> server (untrusted COMMANDS; always validated and authorized):
 *   { v:1, t:"auth", token }                          authenticate or renew (the token is never accepted in the URL)
 *   { v:1, t:"subscribe", id, channel }               join a channel (authorization runs for the RESOLVED channel)
 *   { v:1, t:"unsubscribe", id, channel }
 *   { v:1, t:"event", id, channel, event, payload }   a client command handled by an @OnEvent method of the channel
 *   { v:1, t:"ping" }
 * Server -> client:
 *   { v:1, t:"ready", connectionId, authenticated }
 *   { v:1, t:"ack", id, result? }
 *   { v:1, t:"error", id?, code, message }            stable PSO_CHANNEL_* codes; never a stack or an internal detail
 *   { v:1, t:"event", eventId, type, channel, ts, correlationId?, seq?, payload }    SERVER events (published by services)
 *   { v:1, t:"presence", channel, event:"sync"|"join"|"leave", members?|member? }
 *   { v:1, t:"pong" }
 * Client commands and server events use different frame types and different authorization paths: a client can never
 * produce a `t:"event"` frame that other clients receive.
 */
export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = "pso.channels.v1";

export type ErrorCode =
  | "PSO_CHANNEL_UNAUTHENTICATED" | "PSO_CHANNEL_FORBIDDEN" | "PSO_CHANNEL_INVALID_CHANNEL" | "PSO_CHANNEL_UNKNOWN_EVENT" | "PSO_CHANNEL_INVALID_PAYLOAD"
  | "PSO_CHANNEL_PAYLOAD_TOO_LARGE" | "PSO_CHANNEL_RATE_LIMITED" | "PSO_CHANNEL_SUBSCRIPTION_LIMIT" | "PSO_CHANNEL_UNSUPPORTED_VERSION" | "PSO_CHANNEL_BAD_FRAME"
  | "PSO_CHANNEL_INTERNAL" | "PSO_CHANNEL_UNAVAILABLE" | "PSO_CHANNEL_TOKEN_EXPIRED" | "PSO_CHANNEL_SLOW_CONSUMER";

/** The fixed, client-safe text of each code. Nothing request-specific or internal is ever added. */
export const MESSAGES: Record<ErrorCode, string> = {
  PSO_CHANNEL_UNAUTHENTICATED: "Authentication is required.",
  PSO_CHANNEL_FORBIDDEN: "Not allowed.",
  PSO_CHANNEL_INVALID_CHANNEL: "The channel is not valid.",
  PSO_CHANNEL_UNKNOWN_EVENT: "The event is not supported.",
  PSO_CHANNEL_INVALID_PAYLOAD: "The payload is not valid.",
  PSO_CHANNEL_PAYLOAD_TOO_LARGE: "The message exceeds the size limit.",
  PSO_CHANNEL_RATE_LIMITED: "Too many messages; slow down.",
  PSO_CHANNEL_SUBSCRIPTION_LIMIT: "The subscription limit was reached.",
  PSO_CHANNEL_UNSUPPORTED_VERSION: "Unsupported protocol version; this server speaks version 1.",
  PSO_CHANNEL_BAD_FRAME: "The frame is malformed.",
  PSO_CHANNEL_INTERNAL: "The operation could not be completed.",
  PSO_CHANNEL_UNAVAILABLE: "The service is temporarily unavailable.",
  PSO_CHANNEL_TOKEN_EXPIRED: "The credentials expired; authenticate again.",
  PSO_CHANNEL_SLOW_CONSUMER: "The connection cannot keep up with the event rate.",
};

/** Close codes (4000-4999 are application defined). */
export const CLOSE = { normal: 1000, goingAway: 1001, tooBig: 1009, tryLater: 1013, unauthenticated: 4401, forbidden: 4403, idle: 4408, slow: 4429, badVersion: 4426 } as const;

export class ChannelError extends Error {
  readonly code: ErrorCode;
  /** field problems of an invalid payload: names only, never values */
  readonly errors: Array<{ field?: string; message: string }> | undefined;
  constructor(code: ErrorCode, errors?: Array<{ field?: string; message: string }>) { super(code); this.code = code; this.errors = errors; }
}

/** A server event as it travels between instances and into the hub. */
export interface ChannelEnvelope {
  v: 1;
  /** unique id; downstream consumers use it for idempotency and duplicate suppression */
  id: string;
  type: string;
  channel: string;
  ts: string;
  correlationId?: string;
  /** the publishing service ("local" for code running inside this orchestrator) */
  source: string;
  payload: unknown;
}

const EVENT_TYPE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
export const isEventType = (s: unknown): s is string => typeof s === "string" && s.length <= 100 && EVENT_TYPE.test(s);
export const isUuidLike = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_.:-]{8,100}$/.test(s);

/** Structural validation of an envelope received from a bus or Dispatch. Returns the problem, or undefined when acceptable. */
export function envelopeProblem(e: unknown, maxBytes: number): string | undefined {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return "envelope must be an object";
  const o = e as Record<string, unknown>;
  if (o["v"] !== PROTOCOL_VERSION) return "unsupported protocol version";
  if (!isUuidLike(o["id"])) return "invalid id";
  if (!isEventType(o["type"])) return "invalid type";
  if (typeof o["channel"] !== "string" || o["channel"].length > 200) return "invalid channel";
  if (typeof o["ts"] !== "string" || Number.isNaN(Date.parse(o["ts"]))) return "invalid ts";
  if (o["correlationId"] !== undefined && !(typeof o["correlationId"] === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(o["correlationId"]))) return "invalid correlationId";
  if (typeof o["source"] !== "string" || !/^[a-z][a-z0-9.-]{0,62}$/.test(o["source"])) return "invalid source";
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(o["payload"] ?? null)); } catch { return "payload is not serializable"; }
  if (size > maxBytes) return "payload too large";
  const extra = Object.keys(o).filter((k) => !["v", "id", "type", "channel", "ts", "correlationId", "source", "payload"].includes(k));
  if (extra.length) return "unknown envelope field";
  return undefined;
}
