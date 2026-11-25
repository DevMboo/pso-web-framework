import { existsSync, readFileSync, statSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";

/**
 * Service identity and secure service-to-service communication for the orchestrator's outbound calls (`Upstream`).
 *
 * Each upstream has its own policy; nothing is global and nothing is implicit:
 *  - TLS is standard Node TLS. Certificate and host-name verification are NEVER disabled (there is deliberately no "insecure" switch).
 *    A private CA is trusted through `caFile`; the identity the server certificate must carry is `serverName` (default: the host).
 *  - Mutual TLS: `certFile` + `keyFile` make the orchestrator authenticate itself to the upstream with a client certificate. That is the
 *    SERVICE identity; it is separate from the user's identity, which is only ever the user's own bearer token.
 *  - Certificates are re-read when the files change (rotation without restart); the next connection uses the new material.
 *  - The user's bearer token is forwarded to an upstream only when ALL hold: the route is guarded, the policy allows it (`forward`, falling
 *    back to security.propagation.forward), the connection is TLS or loopback (a token never travels in clear text between hosts), and,
 *    when an \`audience\` is configured, the caller's token names that audience (audience-aware delegation).
 *  - In production a non-loopback upstream must use TLS unless \`allowPlaintext\` says otherwise explicitly.
 * Settings come from pso.config.json (http.upstreams.<name>.*), or the variables PSO_UPSTREAM_<NAME>_TLS_CA_FILE, _TLS_CERT_FILE,
 * _TLS_KEY_FILE, _TLS_KEY_PASSPHRASE (a secret: environment only), _TLS_SERVER_NAME, _FORWARD, _AUDIENCE, _ALLOW_PLAINTEXT.
 */
export interface TlsSettings { caFile?: string; certFile?: string; keyFile?: string; keyPassphrase?: string; serverName?: string }
export interface UpstreamPolicy {
  tls?: TlsSettings;
  /** inherit = follow security.propagation.forward */
  forward: "inherit" | "none" | "bearer";
  audience?: string;
  allowPlaintext: boolean;
}

export class UpstreamSecurityError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`invalid upstream security configuration:\n - ${problems.join("\n - ")}`); this.name = "UpstreamSecurityError"; this.problems = problems; }
}

/** 127.0.0.0/8, ::1 and localhost: traffic that never leaves the machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  return isIP(h) === 4 && h.startsWith("127.");
}

const envName = (service: string): string => service.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const REF = /^\$\{env:([A-Za-z0-9_.-]+)\}$/;
const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Policy of one upstream from the configuration file and the environment (the variable wins). */
export function loadUpstreamPolicy(service: string, env: NodeJS.ProcessEnv, projectDir: string | undefined, problems: string[]): UpstreamPolicy {
  let file: Record<string, unknown> = {};
  if (projectDir) {
    try {
      const doc = JSON.parse(readFileSync(join(projectDir, "pso.config.json"), "utf8").replace(/^﻿/, "")) as { http?: { upstreams?: Record<string, Record<string, unknown>> } };
      file = doc.http?.upstreams?.[service] ?? {};
    } catch { /* no or unreadable file: the variables still apply (an unreadable file is reported by the HTTP settings loader) */ }
  }
  const fileTls = (file["tls"] ?? {}) as Record<string, unknown>;
  const e = (suffix: string): string | undefined => { const v = env[`PSO_UPSTREAM_${envName(service)}_${suffix}`]; return v === undefined || v === "" ? undefined : v; };
  const resolve = (name: string, v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    const m = REF.exec(v);
    if (!m) return v;
    const r = env[m[1]!];
    if (r === undefined || r === "") { problems.push(`${service}: ${name} references the environment variable ${m[1]}, which is not set`); return undefined; }
    return r;
  };
  const tls: TlsSettings = {};
  const ca = resolve("tls.caFile", e("TLS_CA_FILE") ?? asString(fileTls["caFile"])); if (ca) tls.caFile = ca;
  const cert = resolve("tls.certFile", e("TLS_CERT_FILE") ?? asString(fileTls["certFile"])); if (cert) tls.certFile = cert;
  const key = resolve("tls.keyFile", e("TLS_KEY_FILE") ?? asString(fileTls["keyFile"])); if (key) tls.keyFile = key;
  const sn = resolve("tls.serverName", e("TLS_SERVER_NAME") ?? asString(fileTls["serverName"])); if (sn) tls.serverName = sn;
  // a passphrase is a secret: the environment only, never a committed file
  if (asString(fileTls["keyPassphrase"]) !== undefined) problems.push(`${service}: tls.keyPassphrase must not be written in pso.config.json; set PSO_UPSTREAM_${envName(service)}_TLS_KEY_PASSPHRASE instead`);
  const pass = e("TLS_KEY_PASSPHRASE"); if (pass) tls.keyPassphrase = pass;
  if ((tls.certFile === undefined) !== (tls.keyFile === undefined)) problems.push(`${service}: tls.certFile and tls.keyFile must be set together (mutual TLS needs both)`);
  const enabled = e("TLS") === "true" || fileTls["enabled"] === true || Object.keys(tls).length > 0;
  const forwardRaw = e("FORWARD") ?? asString(file["forward"]) ?? "inherit";
  if (!["inherit", "none", "bearer"].includes(forwardRaw)) problems.push(`${service}: forward must be "none", "bearer" or "inherit" (got ${JSON.stringify(forwardRaw.slice(0, 20))})`);
  const audience = e("AUDIENCE") ?? asString(file["audience"]);
  return {
    ...(enabled ? { tls } : {}),
    forward: (["inherit", "none", "bearer"].includes(forwardRaw) ? forwardRaw : "inherit") as UpstreamPolicy["forward"],
    ...(audience ? { audience } : {}),
    allowPlaintext: e("ALLOW_PLAINTEXT") === "true" || file["allowPlaintext"] === true,
  };
}

/** TLS material that follows the files on disk: rotation needs no restart. */
export class TlsMaterial {
  private agent: HttpsAgent | undefined;
  private stamp = "";
  private checkedAt = 0;
  private soonest: Date | undefined;
  /** days until the first of the configured certificates (authority, client certificate) expires; undefined when none is configured */
  get daysLeft(): number | undefined { return this.soonest ? Math.floor((this.soonest.getTime() - Date.now()) / 86_400_000) : undefined; }
  private readonly s: TlsSettings;
  private readonly host: string;
  constructor(settings: TlsSettings, host: string) { this.s = settings; this.host = host; }

  private files(): string[] { return [this.s.caFile, this.s.certFile, this.s.keyFile].filter((f): f is string => !!f); }
  private signature(): string { return this.files().map((f) => { try { const st = statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return `${f}:missing`; } }).join("|"); }

  /** Reads and validates the files; throws a message that never contains key material or passphrases. */
  private build(): HttpsAgent {
    for (const f of this.files()) if (!existsSync(f)) throw new Error(`TLS file not found: ${f}`);
    // validity dates are checked here, so an expired authority or client certificate is named at start-up (and on rotation) instead
    // of surfacing later as a failed handshake on every request
    this.soonest = undefined;
    for (const f of [this.s.caFile, this.s.certFile].filter((x): x is string => !!x)) {
      for (const pem of readFileSync(f, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []) {
        let c: X509Certificate;
        try { c = new X509Certificate(pem); } catch { throw new Error(`TLS file is not a valid PEM certificate: ${f}`); }
        const until = new Date(c.validTo), from = new Date(c.validFrom);
        if (Date.now() > until.getTime()) throw new Error(`${f === this.s.caFile ? "the certificate authority" : "the client certificate"} in ${f} expired on ${until.toISOString().slice(0, 10)}`);
        if (Date.now() < from.getTime()) throw new Error(`the certificate in ${f} is not valid before ${from.toISOString().slice(0, 10)}`);
        if (!this.soonest || until < this.soonest) this.soonest = until;
      }
    }
    const options = {
      ...(this.s.caFile ? { ca: readFileSync(this.s.caFile) } : {}),
      ...(this.s.certFile && this.s.keyFile ? { cert: readFileSync(this.s.certFile), key: readFileSync(this.s.keyFile), ...(this.s.keyPassphrase ? { passphrase: this.s.keyPassphrase } : {}) } : {}),
    };
    try { createSecureContext({ ...options, minVersion: "TLSv1.2" }); } // fails here (at start-up or on rotation) if the key does not match the certificate or the PEM is invalid
    catch (e) { throw new Error(`TLS material is invalid (${(e as { code?: string }).code ?? "unreadable or mismatching certificate and key"})`); }
    return new HttpsAgent({ ...options, minVersion: "TLSv1.2", rejectUnauthorized: true, keepAlive: true, maxSockets: 256, servername: this.s.serverName ?? (isIP(this.host) ? undefined : this.host) } as ConstructorParameters<typeof HttpsAgent>[0]);
  }

  /** Validates once at start-up. */
  init(): void { this.agent = this.build(); this.stamp = this.signature(); this.checkedAt = Date.now(); }

  /** The agent for new connections; picks up rotated files (checked at most once per second). A bad replacement keeps the previous material. */
  current(now = Date.now()): HttpsAgent {
    if (!this.agent) this.init();
    if (now - this.checkedAt >= 1000) {
      this.checkedAt = now;
      const sig = this.signature();
      if (sig !== this.stamp) {
        try { const next = this.build(); const old = this.agent; this.agent = next; this.stamp = sig; setTimeout(() => old?.destroy(), 30_000).unref(); }
        catch { /* a half-written or invalid replacement never disables communication: keep the last good material and retry on the next change */ this.stamp = sig; }
      }
    }
    return this.agent!;
  }
  get serverName(): string | undefined { return this.s.serverName ?? (isIP(this.host) ? undefined : this.host); }
}

/** Whether the user's bearer token may be sent to this upstream on this request. */
export function mayForwardBearer(o: { routePublic: boolean; global: "bearer" | "none"; policy: UpstreamPolicy; tls: boolean; host: string; principalAudiences: readonly string[] | undefined }): { forward: boolean; reason?: string } {
  if (o.routePublic) return { forward: false, reason: "public route" };
  const effective = o.policy.forward === "inherit" ? o.global : o.policy.forward;
  if (effective !== "bearer") return { forward: false, reason: "policy" };
  if (!o.tls && !isLoopbackHost(o.host)) return { forward: false, reason: "plaintext connection to another host" };
  if (o.policy.audience && !(o.principalAudiences ?? []).includes(o.policy.audience)) return { forward: false, reason: "token audience does not include the upstream audience" };
  return { forward: true };
}

/** Start-up rule: in production a remote upstream must use TLS (or be explicitly marked allowPlaintext). */
export function checkProductionTransport(service: string, host: string, policy: UpstreamPolicy, env: NodeJS.ProcessEnv, problems: string[]): void {
  const production = (env["PSO_ENV"] ?? env["NODE_ENV"]) === "production";
  if (production && !policy.tls && !isLoopbackHost(host) && !policy.allowPlaintext) {
    const v = `PSO_UPSTREAM_${envName(service)}`;
    problems.push(`${service}: production requires TLS to ${"non-loopback"} upstreams (set the TLS settings, or allowPlaintext: true to accept the risk explicitly); ${host} is reached over plain HTTP: set ${v}_TLS=true (with ${v}_TLS_CA_FILE for a private CA), or, for this upstream only, ${v}_ALLOW_PLAINTEXT=true`);
  }
}
