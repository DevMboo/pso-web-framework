import { createPublicKey, X509Certificate, createHash, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createLocalJWKSet, errors as joseErrors, type JWK, type JWTVerifyGetKey } from "jose";
import type { Algorithm, JwksSource, PemSource } from "./config.ts";
import { isBlockedAddress } from "./net.ts";
import { JwksFetchError, KeyUnavailableError, SecurityInitError } from "./errors.ts";
import type { SecurityObserver } from "./observer.ts";

/** Something that can hand the verifier the public key for a token. */
export interface KeyProvider {
  /** Loads keys eagerly. Called during bootstrap; failure keeps the application from becoming ready. */
  init(): Promise<void>;
  getKey: JWTVerifyGetKey;
  describe(): Record<string, unknown>;
  close(): void;
}

// ---------------------------------------------------------------- JWKS

export interface Resolver { (hostname: string): Promise<Array<{ address: string; family: number }>> }
export const systemResolver: Resolver = (h) => dnsLookup(h, { all: true, verbatim: true });

export interface JwksDeps {
  resolver?: Resolver; now?: () => number; observer?: SecurityObserver; sleep?: (ms: number) => Promise<void>;
  /** 0..1, for the retry jitter (tests) */
  random?: () => number;
  /** cancels a fetch in flight and the start-up retries (start-up that is being abandoned) */
  signal?: AbortSignal;
}

const PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** Validates a downloaded key set: bounded, public material only, supported key types. */
export function validateJwks(json: unknown): { keys: JWK[] } {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { keys?: unknown }).keys)) throw new JwksFetchError("jwks_invalid", "response is not a JWKS", false);
  const keys = (json as { keys: unknown[] }).keys;
  if (keys.length === 0 || keys.length > 100) throw new JwksFetchError("jwks_invalid", `a key set must contain between 1 and 100 keys (got ${keys.length})`, false);
  const out: JWK[] = [];
  for (const k of keys) {
    if (typeof k !== "object" || k === null) throw new JwksFetchError("jwks_invalid", "a key is not an object", false);
    const jwk = k as JWK & Record<string, unknown>;
    if (PRIVATE_FIELDS.some((f) => f in jwk)) throw new JwksFetchError("jwks_private_material", "the key set contains private or symmetric key material and was rejected", false);
    if (jwk.kty !== "RSA" && jwk.kty !== "EC" && jwk.kty !== "OKP") continue; // unsupported types are ignored, never used
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    out.push(jwk);
  }
  if (out.length === 0) throw new JwksFetchError("jwks_invalid", "the key set has no usable signature keys", false);
  return { keys: out };
}

/**
 * Fetches a JWKS with SSRF protections: the URL comes only from configuration (never from a token); https only
 * (loopback http in development); the host is resolved here, every address is checked against the blocked ranges, and the
 * connection is pinned to the validated address so a second DNS answer cannot redirect it (rebinding). Redirects are refused,
 * time and size are bounded and the content type is checked.
 */
export async function fetchJwks(src: JwksSource, deps: JwksDeps = {}): Promise<{ keys: JWK[] }> {
  const host = src.uri.hostname.replace(/^\[|\]$/g, "");
  let target: { address: string; family: 4 | 6 };
  let targets: Array<{ address: string; family: 4 | 6 }>;
  if (isIP(host)) {
    if (isBlockedAddress(host, src.loopbackAllowed, src.privateAllowed === true)) throw new JwksFetchError("jwks_blocked_address", "the JWKS address is blocked", false);
    targets = [{ address: host, family: isIP(host) as 4 | 6 }];
  } else {
    let addrs: Array<{ address: string; family: number }>;
    try { addrs = await (deps.resolver ?? systemResolver)(host); } catch { throw new JwksFetchError("jwks_dns", "the JWKS host could not be resolved", true); }
    if (addrs.length === 0) throw new JwksFetchError("jwks_dns", "the JWKS host did not resolve", true);
    for (const a of addrs) if (isBlockedAddress(a.address, src.loopbackAllowed, src.privateAllowed === true)) throw new JwksFetchError("jwks_blocked_address", "the JWKS host resolves to a blocked address (private, loopback, link-local or metadata range)", false);
    // every address was validated above; they are tried in turn (IPv4 first: a host without an IPv6 route, a container for example,
    // must not fail because the resolver listed an IPv6 address first). The connection is still pinned to a validated address.
    targets = addrs.map((a) => ({ address: a.address, family: (a.family === 6 ? 6 : 4) as 4 | 6 })).sort((a, b) => a.family - b.family);
  }
  const mod = src.uri.protocol === "https:" ? https : http;
  if (deps.signal?.aborted) throw new JwksFetchError("jwks_cancelled", "the JWKS request was cancelled", false);
  let ca: Buffer | undefined;
  if (src.caFile) { try { ca = readFileSync(src.caFile); } catch { throw new JwksFetchError("jwks_tls", "the certificate authority file of the JWKS endpoint cannot be read", false); } }
  let body: Buffer | undefined;
  let unreachable: JwksFetchError | undefined;
  for (target of targets) {
    try { body = await attempt(); break; }
    catch (e) {
      // an address that cannot be connected to (including a connection that fails before the request object exists) is a network
      // problem of that address: the next validated address is tried; anything else (TLS, status, content, size) ends the fetch
      const err = e instanceof JwksFetchError ? e : new JwksFetchError("jwks_network", "the JWKS endpoint could not be reached", true);
      if (err.code !== "jwks_network" && err.code !== "jwks_connect_timeout") throw err;
      unreachable = err;
    }
  }
  if (body === undefined) throw unreachable ?? new JwksFetchError("jwks_network", "the JWKS endpoint could not be reached", true);
  let json: unknown;
  try { json = JSON.parse(body.toString("utf8")); } catch { throw new JwksFetchError("jwks_invalid", "the JWKS response is not valid JSON", false); }
  return validateJwks(json);

  function attempt(): Promise<Buffer> { return new Promise<Buffer>((resolve, reject) => {
    const req = mod.request({
      protocol: src.uri.protocol, hostname: src.uri.hostname.replace(/^\[|\]$/g, ""), port: src.uri.port || undefined, path: `${src.uri.pathname}${src.uri.search}`, method: "GET",
      headers: { accept: "application/json, application/jwk-set+json", "user-agent": "pso-security" }, servername: isIP(host) ? undefined : host, agent: false, ...(ca ? { ca } : {}),
      lookup: (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family)),
    } as https.RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return reject(new JwksFetchError("jwks_redirect", "redirects are not followed", false)); }
      if (status !== 200) { res.resume(); return reject(new JwksFetchError("jwks_status", `the JWKS endpoint answered HTTP ${status}`, status >= 500 || status === 429)); }
      if (!/json/i.test(String(res.headers["content-type"] ?? ""))) { res.resume(); return reject(new JwksFetchError("jwks_content_type", "the JWKS response is not JSON", false)); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > src.maxBytes) { req.destroy(); reject(new JwksFetchError("jwks_too_large", `the JWKS response exceeds ${src.maxBytes} bytes`, false)); } else chunks.push(c); });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", () => reject(new JwksFetchError("jwks_network", "the JWKS response was interrupted", true)));
    });
    const timer = setTimeout(() => { req.destroy(); reject(new JwksFetchError("jwks_timeout", `the JWKS request exceeded ${src.timeoutMs} ms`, true)); }, src.timeoutMs);
    // the connection itself has a shorter bound, so an address that silently drops packets costs little and the next one is tried
    const connectMs = Math.min(src.connectTimeoutMs ?? 2000, src.timeoutMs);
    const connecting = setTimeout(() => { req.destroy(); reject(new JwksFetchError("jwks_connect_timeout", `no connection to the JWKS endpoint within ${connectMs} ms`, true)); }, connectMs);
    req.on("socket", (s) => { const up = (): void => clearTimeout(connecting); if (!s.connecting) up(); else s.once(src.uri.protocol === "https:" ? "secureConnect" : "connect", up); });
    const onAbort = (): void => { req.destroy(); reject(new JwksFetchError("jwks_cancelled", "the JWKS request was cancelled", false)); };
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => {
      clearTimeout(timer); clearTimeout(connecting);
      if (e instanceof JwksFetchError) return reject(e);
      // certificate problems are permanent and must be visible as such: retrying cannot make an untrusted endpoint trustworthy
      const code = String((e as NodeJS.ErrnoException).code ?? "");
      if (/CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)|ERR_TLS|HOSTNAME_MISMATCH|DEPTH_ZERO|ALTNAME/.test(code)) return reject(new JwksFetchError("jwks_tls", `TLS verification of the JWKS endpoint failed (${code})`, false));
      reject(new JwksFetchError("jwks_network", "the JWKS endpoint could not be reached", true));
    });
    req.on("close", () => { clearTimeout(timer); clearTimeout(connecting); deps.signal?.removeEventListener("abort", onAbort); });
    req.end();
  }); }
}

/**
 * JWKS key provider with bounded caching, single-flight refresh and controlled rotation: keys are refreshed when the cache
 * expires, or at most once per cooldown when a token names an unknown key. If a refresh fails the previous keys keep
 * serving until `maxStaleMs`; after that verification fails with a key-unavailable error (distinct from an invalid token).
 */
export class JwksKeyProvider implements KeyProvider {
  private keys: JWK[] = [];
  private local: ReturnType<typeof createLocalJWKSet> | undefined;
  private fetchedAt = 0;
  private lastAttempt = 0;
  private inflight: Promise<void> | undefined;
  private fetches = 0;
  private failures = 0;
  /** upper bound of start-up attempts, whatever the deadline */
  static readonly MAX_INIT_ATTEMPTS = 12;
  private readonly now: () => number;
  private readonly src: JwksSource;
  private readonly deps: JwksDeps;
  constructor(src: JwksSource, deps: JwksDeps = {}) { this.src = src; this.deps = deps; this.now = deps.now ?? Date.now; }

  async init(): Promise<void> {
    // Bounded start-up load. A transient failure (DNS, connection, timeout, 5xx, 429) is retried with exponential backoff and jitter
    // until the overall deadline or the attempt limit, whichever comes first; a permanent one (TLS, blocked address, redirect, bad
    // content) ends at once. Nothing is verified without keys: when this fails the application does not start.
    const signal = this.deps.signal;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(done, ms); function done(): void { clearTimeout(t); signal?.removeEventListener("abort", done); r(); } signal?.addEventListener("abort", done, { once: true }); }));
    const random = this.deps.random ?? Math.random;
    const started = Date.now();
    const deadline = this.src.initDeadlineMs ?? 20_000;
    let last: unknown;
    let attempts = 0;
    let delay = 250;
    for (;;) {
      attempts++;
      try { await this.refresh("init"); if (attempts > 1) this.deps.observer?.onJwks({ type: "jwks_refreshed", reason: `init after ${attempts} attempts`, keys: this.keys.length }); return; } catch (e) {
        last = e;
        if (!(e instanceof JwksFetchError) || !e.transient || signal?.aborted) break; // permanent problems are not retried
        const remaining = deadline - (Date.now() - started);
        if (attempts >= JwksKeyProvider.MAX_INIT_ATTEMPTS || remaining <= 0) break;
        await sleep(Math.max(1, Math.min(remaining, Math.round(delay * (0.5 + random() * 0.5))))); // "equal jitter": between half the step and the step
        if (signal?.aborted) { last = new JwksFetchError("jwks_cancelled", "start-up was cancelled", false); break; }
        delay = Math.min(delay * 2, 5000);
      }
    }
    const err = last as JwksFetchError;
    throw new SecurityInitError(`could not load the signing keys from ${this.src.uri.host}: ${err.code ?? "error"}: ${err.message} (${attempts} attempt${attempts === 1 ? "" : "s"} in ${Date.now() - started} ms)`, err.transient === true);
  }

  private refresh(reason: string): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.now();
    this.inflight = (async () => {
      try {
        const set = await fetchJwks(this.src, this.deps);
        this.keys = set.keys; this.local = createLocalJWKSet(set); this.fetchedAt = this.now(); this.fetches++;
        this.deps.observer?.onJwks({ type: "jwks_refreshed", reason, keys: set.keys.length });
      } catch (e) {
        this.failures++;
        this.deps.observer?.onJwks({ type: "jwks_refresh_failed", reason, code: e instanceof JwksFetchError ? e.code : "error" });
        throw e;
      } finally { this.inflight = undefined; }
    })();
    return this.inflight;
  }

  getKey: JWTVerifyGetKey = async (header, token) => {
    const age = this.now() - this.fetchedAt;
    if (!this.local || age > this.src.cacheTtlMs) {
      try { await this.refresh(this.local ? "expired" : "cold"); } catch {
        if (!this.local || age > this.src.maxStaleMs) throw new KeyUnavailableError("signing keys are unavailable");
        // otherwise keep serving the previous, still-fresh-enough keys
      }
    }
    const local = this.local!;
    try { return await local(header, token); } catch (e) {
      if (e instanceof joseErrors.JWKSNoMatchingKey && this.now() - this.lastAttempt >= this.src.cooldownMs) {
        try { await this.refresh("unknown_kid"); } catch { throw new KeyUnavailableError("signing keys are unavailable"); }
        return this.local!(header, token);
      }
      throw e;
    }
  };

  describe(): Record<string, unknown> { return { kind: "jwks", host: this.src.uri.host, keys: this.keys.map((k) => k.kid ?? "(no kid)"), fetches: this.fetches, failures: this.failures, ageSeconds: this.fetchedAt ? Math.round((this.now() - this.fetchedAt) / 1000) : null }; }
  close(): void { this.local = undefined; this.keys = []; }
}

// ---------------------------------------------------------------- PEM / X.509

export interface LoadedPublicKey { key: KeyObject; source: "spki" | "x509"; fingerprint: string; notAfter?: Date; notBefore?: Date }

const CURVE_ALG: Record<string, Algorithm> = { "prime256v1": "ES256", "secp384r1": "ES384", "secp521r1": "ES512" };

function compatible(key: KeyObject, alg: Algorithm): boolean {
  const t = key.asymmetricKeyType;
  if (t === "rsa" || t === "rsa-pss") return /^(RS|PS)(256|384|512)$/.test(alg) && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
  if (t === "ec") return CURVE_ALG[key.asymmetricKeyDetails?.namedCurve ?? ""] === alg;
  if (t === "ed25519" || t === "ed448") return alg === "EdDSA";
  return false;
}

/**
 * Loads a PEM public key (SPKI) or X.509 certificate for verification. A private key is refused. A certificate is used as a
 * pinned container for its public key: its validity period is enforced, but PSO does NOT build or verify a certificate chain
 * and does NOT check revocation; trust is exactly "this certificate".
 */
export function loadPublicKeyFile(file: string, algorithms: readonly Algorithm[], now: Date = new Date()): LoadedPublicKey {
  const fail = (code: string, msg: string): never => { throw new JwksFetchError(code, msg, false); };
  if (!existsSync(file)) return fail("pem_missing", "the public key file does not exist");
  const st = statSync(file);
  if (!st.isFile()) return fail("pem_not_file", "the public key path is not a regular file");
  if (st.size > 65_536) return fail("pem_too_large", "the public key file is larger than 64 KiB");
  const pem = readFileSync(file, "utf8");
  if (/PRIVATE KEY/.test(pem) || /ENCRYPTED/.test(pem)) return fail("pem_private_key", "the file contains a private key; only public keys or certificates are accepted for verification");
  const blocks = [...pem.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----/g)].map((m) => m[1]!);
  if (blocks.length !== 1) return fail("pem_malformed", `expected exactly one PEM block, found ${blocks.length}`);
  let key: KeyObject, source: "spki" | "x509", notAfter: Date | undefined, notBefore: Date | undefined;
  try {
    if (blocks[0] === "PUBLIC KEY") { key = createPublicKey(pem); source = "spki"; }
    else if (blocks[0] === "CERTIFICATE") {
      const c = new X509Certificate(pem);
      notBefore = new Date(c.validFrom); notAfter = new Date(c.validTo);
      if (now < notBefore) return fail("cert_not_yet_valid", "the certificate is not valid yet");
      if (now > notAfter) return fail("cert_expired", "the certificate has expired");
      key = c.publicKey; source = "x509";
    } else return fail("pem_unsupported", `unsupported PEM block "${blocks[0]}": use PUBLIC KEY or CERTIFICATE`);
  } catch (e) {
    if (e instanceof JwksFetchError) throw e;
    return fail("pem_malformed", "the PEM content could not be parsed");
  }
  if (!["rsa", "rsa-pss", "ec", "ed25519", "ed448"].includes(key.asymmetricKeyType ?? "")) return fail("pem_key_type", "unsupported key type");
  for (const a of algorithms) if (!compatible(key, a)) return fail("alg_key_mismatch", `algorithm ${a} is not compatible with this ${key.asymmetricKeyType} key (RSA needs >= 2048 bits and RS*/PS*; EC needs the matching ES* curve; Ed25519 needs EdDSA)`);
  return { key, source, fingerprint: createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex"), ...(notAfter ? { notAfter } : {}), ...(notBefore ? { notBefore } : {}) };
}

/** PEM provider with controlled reload: the file's modification time is checked at most every 5 seconds, so rotation needs no restart. */
export class PemKeyProvider implements KeyProvider {
  private loaded: LoadedPublicKey | undefined;
  private mtime = 0;
  private checkedAt = 0;
  private reloads = 0;
  private readonly src: PemSource;
  private readonly algorithms: readonly Algorithm[];
  private readonly deps: { now?: () => number; observer?: SecurityObserver };
  constructor(src: PemSource, algorithms: readonly Algorithm[], deps: { now?: () => number; observer?: SecurityObserver } = {}) { this.src = src; this.algorithms = algorithms; this.deps = deps; }

  private load(): void {
    try { this.loaded = loadPublicKeyFile(this.src.file, this.algorithms); this.mtime = statSync(this.src.file).mtimeMs; this.reloads++; }
    catch (e) { throw e instanceof JwksFetchError ? new SecurityInitError(`public key file rejected: ${e.code}: ${e.message}`, false) : e; }
  }
  async init(): Promise<void> { this.load(); }

  getKey: JWTVerifyGetKey = async () => {
    const now = (this.deps.now ?? Date.now)();
    if (now - this.checkedAt > 5000) {
      this.checkedAt = now;
      try {
        if (statSync(this.src.file).mtimeMs !== this.mtime) { this.loaded = loadPublicKeyFile(this.src.file, this.algorithms); this.mtime = statSync(this.src.file).mtimeMs; this.reloads++; this.deps.observer?.onJwks({ type: "key_reloaded", reason: "file_changed", keys: 1 }); }
      } catch { /* keep the last good key; a bad replacement never disables or replaces working verification */ }
    }
    if (!this.loaded) throw new KeyUnavailableError("no public key loaded");
    if (this.loaded.notAfter && new Date(now) > this.loaded.notAfter) throw new KeyUnavailableError("the pinned certificate has expired");
    return this.loaded.key;
  };
  describe(): Record<string, unknown> { return { kind: "pem", source: this.loaded?.source ?? null, fingerprintSha256: this.loaded?.fingerprint.slice(0, 16) ?? null, notAfter: this.loaded?.notAfter?.toISOString() ?? null, reloads: this.reloads }; }
  close(): void { this.loaded = undefined; }
}
