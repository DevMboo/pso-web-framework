import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Publisher authentication for Dispatch (identical in the Java runtime).
 *
 * The envelope's `source` is a field any producer can write: on its own it proves nothing. A service that has a signing key adds a
 * transport header to every message it publishes:
 *
 *   x-pso-signature: v1=<base64url( HMAC-SHA256( key, channel + "\n" + the exact envelope bytes ) )>
 *
 * A consumer holds the key of each service it trusts and looks the key up BY THE SOURCE THE ENVELOPE CLAIMS. So a service that only
 * has its own key cannot produce a message that verifies for another service's name, and nothing in the message can be changed (or the
 * message moved to another channel) without invalidating it.
 *
 * What this is and is not:
 *  - it authenticates "this message was produced by a holder of <source>'s key and was not altered". Keys are symmetric: a consumer
 *    that verifies a service could also sign as it, so give each key only to its service and to the consumers that must verify it;
 *  - it does not prevent REPLAY of a captured, validly signed message by someone who can write to the broker. Duplicate suppression
 *    (the idempotency store) covers replays inside its retention; broker authentication and ACLs remain the first line of defence;
 *  - the envelope format does not change: a consumer that does not verify ignores the header, so services can be upgraded one by one.
 */
export const SIGNATURE_HEADER = "x-pso-signature";
const SCHEME = "v1";
export const MIN_KEY_LENGTH = 32;

/**
 * off:        signatures are neither required nor checked (the behaviour before signatures existed).
 * permissive: a message whose signature is wrong for a source we hold a key for is refused; unsigned messages and sources without a
 *             key are still accepted (and counted). For migrations: turn signing on everywhere, watch the counter reach zero.
 * required:   every consumed message must carry a valid signature of its claimed source; anything else is dead-lettered unprocessed.
 */
export type TrustMode = "off" | "permissive" | "required";
export const TRUST_MODES: readonly TrustMode[] = ["off", "permissive", "required"];

export interface DispatchTrust {
  mode: TrustMode;
  /** this service's key: when set, every published message is signed */
  signingKey?: string;
  /** verification keys by source service name; several keys per source allow rotation */
  keys: ReadonlyMap<string, readonly string[]>;
}
export const NO_TRUST: DispatchTrust = { mode: "off", keys: new Map() };

export type Verdict = "verified" | "unsigned" | "unknown-source" | "invalid";

const mac = (key: string, channel: string, body: Buffer): Buffer => createHmac("sha256", key).update(channel, "utf8").update("\n").update(body).digest();

export function signMessage(key: string, channel: string, body: Buffer): string {
  return `${SCHEME}=${mac(key, channel, body).toString("base64url")}`;
}

/** Checks the signature header of one received message against the keys held for the source its envelope claims. */
export function verifyMessage(trust: DispatchTrust, channel: string, body: Buffer, header: string | undefined, claimedSource: string): Verdict {
  if (header === undefined || header === "") return "unsigned";
  const keys = trust.keys.get(claimedSource);
  if (!keys || keys.length === 0) return "unknown-source";
  if (!header.startsWith(`${SCHEME}=`) || header.length > 200) return "invalid";
  let got: Buffer;
  try { got = Buffer.from(header.slice(SCHEME.length + 1), "base64url"); } catch { return "invalid"; }
  if (got.length !== 32) return "invalid";
  for (const k of keys) if (timingSafeEqual(mac(k, channel, body), got)) return "verified";
  return "invalid";
}

/** `users-service` -> `USERS_SERVICE` (the PSO_UPSTREAM_<NAME> convention) */
export const envNameOf = (service: string): string => service.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * Keys come from the environment only (never a configuration file):
 *   PSO_DISPATCH_SIGNING_KEY            this service's key (32+ characters)
 *   PSO_DISPATCH_TRUST_KEY_<SERVICE>    the key(s) of a publisher this service verifies, comma separated while rotating
 * A service always verifies its own messages with its own signing key.
 */
export function loadTrustKeys(env: Record<string, string | undefined>, ownSource: string, problems: Array<{ code: string; key?: string; message: string }>): Pick<DispatchTrust, "signingKey" | "keys"> {
  const keys = new Map<string, string[]>();
  const add = (source: string, list: string[], variable: string): void => {
    if (list.some((k) => k.length < MIN_KEY_LENGTH)) { problems.push({ code: "PSO_DISPATCH_TRUST_KEY", key: variable, message: `${variable} must be at least ${MIN_KEY_LENGTH} characters (use a random value, for example 32 bytes in base64)` }); return; }
    keys.set(source, [...(keys.get(source) ?? []), ...list]);
  };
  const signingKey = env["PSO_DISPATCH_SIGNING_KEY"]?.trim() || undefined;
  if (signingKey) add(ownSource, [signingKey], "PSO_DISPATCH_SIGNING_KEY");
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("PSO_DISPATCH_TRUST_KEY_") || !value) continue;
    const source = name.slice("PSO_DISPATCH_TRUST_KEY_".length).toLowerCase().replace(/_/g, "-");
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(source)) { problems.push({ code: "PSO_DISPATCH_TRUST_KEY", key: name, message: `${name} does not name a service (PSO_DISPATCH_TRUST_KEY_<SERVICE>, for example PSO_DISPATCH_TRUST_KEY_USERS_SERVICE)` }); continue; }
    add(source, value.split(",").map((s) => s.trim()).filter(Boolean), name);
  }
  return { ...(signingKey && signingKey.length >= MIN_KEY_LENGTH ? { signingKey } : {}), keys };
}
