import { decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";
import type { SecurityConfig } from "./config.ts";
import { KeyUnavailableError, type AuthFailure } from "./errors.ts";
import type { KeyProvider } from "./keys.ts";
import { Principal } from "./principal.ts";

export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: AuthFailure };

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;
const MAX_GRANTS = 256;

const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>)[k] : undefined), o);
function grants(v: unknown): string[] {
  const raw = typeof v === "string" ? v.split(/\s+/) : Array.isArray(v) ? v : [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200).slice(0, MAX_GRANTS);
}

/**
 * The JWT verification engine. Cryptography is delegated to `jose`; this class decides what is acceptable:
 * strict Bearer parsing, size limit, explicit algorithm allow-list, issuer, audience, expiry, not-before, required claims,
 * non-empty subject. Unsigned tokens, symmetric algorithms and tokens that try to pick their own key source (jku/x5u/jwk
 * headers) are rejected. Nothing from an unverified token is trusted: claims are read only after the signature is verified.
 */
export class JwtVerifier {
  private readonly cfg: SecurityConfig["authentication"];
  private readonly keys: KeyProvider;
  constructor(cfg: SecurityConfig["authentication"], keys: KeyProvider) { this.cfg = cfg; this.keys = keys; }

  async verifyAuthorization(header: string | string[] | undefined): Promise<AuthResult> {
    if (header === undefined) return { ok: false, reason: "missing_header" };
    if (typeof header !== "string") return { ok: false, reason: "malformed_header" };
    if (Buffer.byteLength(header) > this.cfg.maxTokenBytes + 7) return { ok: false, reason: "token_too_large" };
    const m = BEARER.exec(header);
    if (!m) return { ok: false, reason: "malformed_header" };
    return this.verifyToken(m[1]!);
  }

  async verifyToken(token: string): Promise<AuthResult> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try { header = decodeProtectedHeader(token); } catch { return { ok: false, reason: "malformed_token" }; }
    if (typeof header.alg !== "string" || header.alg === "none" || !(this.cfg.algorithms as string[]).includes(header.alg)) return { ok: false, reason: "bad_algorithm" };
    if ("jku" in header || "x5u" in header || "jwk" in header) return { ok: false, reason: "forbidden_header" };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys.getKey, {
        algorithms: [...this.cfg.algorithms], issuer: this.cfg.issuer, audience: this.cfg.audiences, requiredClaims: ["exp", "sub"],
        clockTolerance: this.cfg.clockToleranceSeconds, ...(this.cfg.tokenType ? { typ: this.cfg.tokenType } : {}),
      }));
    } catch (e) { return { ok: false, reason: classify(e) }; }
    if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 512) return { ok: false, reason: "invalid_subject" };
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    return {
      ok: true,
      principal: new Principal({
        subject: payload.sub, issuer: String(payload.iss ?? this.cfg.issuer), audiences: aud, expiresAt: new Date((payload.exp ?? 0) * 1000),
        scopes: [...grants(payload["scope"]), ...grants(payload["scp"])],
        roles: grants(at(payload, this.cfg.rolesClaim)), permissions: grants(at(payload, this.cfg.permissionsClaim)),
      }),
    };
  }
}

/** Maps verification errors to internal classifications. These are for logs and metrics only. */
export function classify(e: unknown): AuthFailure {
  if (e instanceof KeyUnavailableError) return "key_unavailable";
  if (e instanceof errors.JWTExpired) return "expired";
  if (e instanceof errors.JWTClaimValidationFailed) {
    if (e.claim === "nbf") return "not_yet_valid";
    if (e.claim === "iss") return "bad_issuer";
    if (e.claim === "aud") return "bad_audience";
    return e.reason === "missing" ? "missing_claim" : "invalid";
  }
  if (e instanceof errors.JWSSignatureVerificationFailed) return "bad_signature";
  if (e instanceof errors.JOSEAlgNotAllowed) return "bad_algorithm";
  if (e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JWKSMultipleMatchingKeys) return "unknown_key";
  if (e instanceof errors.JWSInvalid || e instanceof errors.JWTInvalid) return "malformed_token";
  return "invalid";
}
