import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { redactText } from "./redact.ts";

/**
 * Client-side access diagnostics and the guarded request tester. Everything here runs on the machine of the person using PSO (CLI or Studio);
 * TLS verification is NEVER disabled: a certificate that cannot be verified is reported as such, with the reason.
 */
export interface UrlEntry { scheme: string; host: string | null; hostSource: string; port: number; path: string; visibility: "private" | "public-binding"; redirectsTo: string | null; tls: { certificate: string | null } | null; service: string | null; source: string }
export interface ResolvedUrl extends UrlEntry { url: string; resolvedHost: string; hostNote: string | null }

/** The base URL of each entry; a server block without a server_name answers on the server's own address, which the connection record knows. */
export function resolveUrls(urls: UrlEntry[], serverAddress: string): ResolvedUrl[] {
  return urls.map((u) => {
    const host = u.host ?? serverAddress; const std = (u.scheme === "https" && u.port === 443) || (u.scheme === "http" && u.port === 80);
    return { ...u, resolvedHost: host, url: `${u.scheme}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${std ? "" : `:${u.port}`}${u.path === "/" ? "/" : u.path.replace(/[*^$~]/g, "")}`, hostNote: u.host ? null : "no server_name: the address of the connection is used" };
  });
}

export type ProbeOutcome = "reachable" | "tls-untrusted" | "tls-name-mismatch" | "tls-expired" | "timeout" | "refused" | "dns-failure" | "reset" | "other-error";
export interface ProbeResult { outcome: ProbeOutcome; status?: number; ms: number; detail: string; tlsAuthorized?: boolean; peerCertificate?: { subject: string; issuer: string; validTo: string; san: string | null } }
const CERT_CODES: Record<string, ProbeOutcome> = { UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls-untrusted", SELF_SIGNED_CERT_IN_CHAIN: "tls-untrusted", DEPTH_ZERO_SELF_SIGNED_CERT: "tls-untrusted", UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls-untrusted", ERR_TLS_CERT_ALTNAME_INVALID: "tls-name-mismatch", CERT_HAS_EXPIRED: "tls-expired" };

/** GET with FULL verification against the system trust, or against `caFile` when the environment uses a private CA. */
export function probeHttps(url: string, o: { caFile?: string; timeoutMs?: number; path?: string; servername?: string } = {}): Promise<ProbeResult> {
  const u = new URL(url); const t0 = Date.now(); const timeoutMs = o.timeoutMs ?? 8000;
  return new Promise((res) => {
    let done = false; const fin = (r: Omit<ProbeResult, "ms">): void => { if (!done) { done = true; res({ ...r, ms: Date.now() - t0 }); } };
    const isTls = u.protocol === "https:";
    const common = { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || (isTls ? 443 : 80)), path: o.path ?? (u.pathname || "/"), method: "GET", timeout: timeoutMs, agent: false as const, headers: { connection: "close", "user-agent": "pso-access-check" } };
    const req = isTls
      ? request({ ...common, rejectUnauthorized: true, ...(o.caFile ? { ca: readFileSync(o.caFile) } : {}), ...(o.servername ? { servername: o.servername } : {}) }, (r) => {
        const c = (r.socket as { getPeerCertificate?: () => { subject?: { CN?: string }; issuer?: { CN?: string }; valid_to?: string; subjectaltname?: string } }).getPeerCertificate?.();
        r.resume(); r.on("end", () => fin({ outcome: "reachable", status: r.statusCode ?? 0, detail: `HTTP ${r.statusCode} over verified TLS`, tlsAuthorized: true, ...(c?.subject ? { peerCertificate: { subject: c.subject.CN ?? "?", issuer: c.issuer?.CN ?? "?", validTo: c.valid_to ?? "?", san: c.subjectaltname ?? null } } : {}) }));
      })
      : httpRequest(common, (r) => { r.resume(); r.on("end", () => fin({ outcome: "reachable", status: r.statusCode ?? 0, detail: `HTTP ${r.statusCode} (plain HTTP: not verified, nothing secret may be sent)` })); });
    req.on("timeout", () => { req.destroy(); fin({ outcome: "timeout", detail: `no answer within ${Math.round(timeoutMs / 1000)}s (a dropped or filtered connection looks like this; it is not proof of what dropped it)` }); });
    req.on("error", (e: NodeJS.ErrnoException) => {
      const c = e.code ?? ""; if (CERT_CODES[c]) return fin({ outcome: CERT_CODES[c]!, detail: `${c}: ${redactText(e.message)}`, tlsAuthorized: false });
      if (c === "ECONNREFUSED") return fin({ outcome: "refused", detail: "the host answered and nothing listens on that port (or a firewall rejects it)" });
      if (c === "ENOTFOUND" || c === "EAI_AGAIN") return fin({ outcome: "dns-failure", detail: `the name does not resolve (${c})` });
      if (c === "ECONNRESET") return fin({ outcome: "reset", detail: "the connection was reset" });
      if (c === "ETIMEDOUT") return fin({ outcome: "timeout", detail: "connection attempt timed out (ETIMEDOUT)" });
      fin({ outcome: "other-error", detail: `${c || "error"}: ${redactText(e.message).slice(0, 160)}` });
    });
    req.end();
  });
}
/** Plain TCP connect from this machine: tells "answers" from "silent" from "refused". */
export function tcpProbe(host: string, port: number, timeoutMs = 4000): Promise<"open" | "refused" | "no-answer"> {
  return new Promise((res) => { const s = createConnection({ host, port, timeout: timeoutMs }); s.once("connect", () => { s.destroy(); res("open"); }); s.once("timeout", () => { s.destroy(); res("no-answer"); }); s.once("error", (e: NodeJS.ErrnoException) => res(e.code === "ECONNREFUSED" ? "refused" : "no-answer")); });
}

export interface Overview { services: Array<{ name: string; instances: Array<{ running: boolean; localHealth: { ok: boolean } | null }>; viaProxy: { ok: boolean; servesActiveRelease: boolean } | null }>; proxy: { matchesActiveRelease: boolean } | null; urls: UrlEntry[]; release: { active: string | null } }
export interface Step { id: string; label: string; status: "verified" | "failed" | "not-verified" | "not-applicable"; detail: string }
export interface Reachability { app: string; steps: Step[]; summary: string; diagnosis: string[]; publicInternetVerified: false; note: string }

/** The independent layers, in order. A later layer never implies an earlier one and `COMPLETED` is not one of them. */
export async function diagnose(app: string, ov: Overview, c: { host: string; localFirewall?: "unknown" | "none"; caFile?: string; tunnelBase?: string | null; tunnelNote?: string; }, listeningAll: boolean | undefined): Promise<Reachability> {
  const steps: Step[] = []; const diag: string[] = [];
  const insts = ov.services.flatMap((s) => s.instances);
  steps.push({ id: "process", label: "Application process running", status: insts.length && insts.every((i) => i.running) ? "verified" : "failed", detail: `${insts.filter((i) => i.running).length} of ${insts.length} instance(s) running` });
  const hc = insts.filter((i) => i.localHealth); steps.push({ id: "local-health", label: "Local health check on the server", status: hc.length && hc.every((i) => i.localHealth!.ok) ? "verified" : hc.length ? "failed" : "not-verified", detail: hc.length ? `${hc.filter((i) => i.localHealth!.ok).length} of ${hc.length} healthy` : "no running instance to ask" });
  const vp = ov.services.filter((s) => s.viaProxy); steps.push({ id: "proxy-on-server", label: "Reverse proxy reachable on the server", status: ov.proxy && vp.length && vp.every((s) => s.viaProxy!.ok && s.viaProxy!.servesActiveRelease) ? "verified" : ov.proxy ? "failed" : "not-applicable", detail: ov.proxy ? `proxy file ${ov.proxy.matchesActiveRelease ? "matches" : "does NOT match"} the active release; ${vp.filter((s) => s.viaProxy!.servesActiveRelease).length} of ${vp.length} service listener(s) serve it` : "no reverse proxy configured" });
  const pub = ov.urls.filter((u) => u.visibility === "public-binding" && !u.redirectsTo); const target = pub.find((u) => u.scheme === "https") ?? pub[0];
  let direct: ProbeResult | undefined;
  if (target) {
    const url = resolveUrls([target], c.host)[0]!.url; direct = await probeHttps(url, { ...(c.caFile ? { caFile: c.caFile } : {}) });
    steps.push({ id: "client-direct", label: `Reachable from this machine (${url})`, status: direct.outcome === "reachable" ? "verified" : "failed", detail: direct.outcome === "reachable" ? `${direct.detail} in ${direct.ms} ms${direct.peerCertificate ? `; certificate ${direct.peerCertificate.subject} issued by ${direct.peerCertificate.issuer}, valid until ${direct.peerCertificate.validTo}` : ""}` : `${direct.outcome}: ${direct.detail}` });
    if (direct.outcome !== "reachable") {
      if (/^tls-/.test(direct.outcome)) diag.push(`The TLS certificate could not be verified (${direct.outcome}). Verification stays on: give this environment its CA file (the certificate's issuer) or fix the certificate's names. The service itself answered.`);
      else if (direct.outcome === "timeout" && steps.slice(0, 3).every((s) => s.status === "verified" || s.status === "not-applicable")) diag.push(`The application is healthy on the server and nginx serves it, but this machine received no answer on port ${target.port}. A dropped (not refused) connection is typical of filtering between this machine and the server${listeningAll ? " (the port listens on all interfaces)" : ""}: a cloud network rule or a firewall on the path. This is a hypothesis: the server cannot see those rules and nothing here proves which one drops it.`);
      else if (direct.outcome === "refused") diag.push("The host answered and refused the connection: nginx is not listening on that port, or a firewall rejects it. Check the PSO-managed nginx file and `ss -ltn` on the server.");
      else if (direct.outcome === "dns-failure") diag.push("The server name does not resolve from this machine: fix DNS, or use the server's IP address (no domain is required).");
      if (steps[0]!.status !== "verified") diag.push("The application process is not running: see the Services view and the runtime logs.");
      else if (steps[1]!.status === "failed") diag.push("The process runs but its local health check fails: check the application's own logs and readiness path.");
      if (steps[2]!.status === "failed") diag.push("nginx does not serve the active release: compare the proxy file with the active release (NGINX view) and redeploy or restore.");
    }
  } else steps.push({ id: "client-direct", label: "Reachable from this machine", status: "not-applicable", detail: "no public URL is configured (private application: use an SSH tunnel)" });
  steps.push({ id: "tunnel", label: "Reachable through an authenticated SSH tunnel", status: c.tunnelBase ? "verified" : "not-verified", detail: c.tunnelNote ?? "not tested (ask for --tunnel)" });
  const tls = ov.urls.some((u) => u.tls); steps.push({ id: "tls", label: "TLS certificate verified by this machine", status: direct?.tlsAuthorized ? "verified" : tls ? (direct && /^tls-/.test(direct.outcome) ? "failed" : "not-verified") : "not-applicable", detail: direct?.tlsAuthorized ? "chain and server name verified" : tls ? (direct && /^tls-/.test(direct.outcome) ? direct.detail : "no TLS handshake completed from this machine, so the certificate was not examined") : "no TLS configured" });
  steps.push({ id: "public-internet", label: "Public internet verified", status: "not-verified", detail: direct?.outcome === "reachable" ? "reachable from THIS machine; a machine on another network is the only real test, and none was used" : "not verified" });
  const summary = direct?.outcome === "reachable" ? "reachable from this machine" : target ? `not reachable from this machine (${direct?.outcome})` : "no public URL configured";
  return { app, steps, summary, diagnosis: diag, publicInternetVerified: false, note: "Deployment COMPLETED, process health, proxy health and reachability are independent facts; each row above is measured separately." };
}

// ================================================================== guarded request tester
export interface TestRequest { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; token?: string }
export interface TestOptions { baseUrl: string; caFile?: string; confirmMutating?: boolean; timeoutMs?: number }
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]); const ALL_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const FORBIDDEN_HEADERS = /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|te|expect|x-forwarded-.*|x-real-ip)$/i;
export const isMutating = (m: string): boolean => !SAFE_METHODS.has(m.toUpperCase());

/** Executes ONE request against the application's own URL (derived from deployment metadata, never typed freely) with full TLS verification. */
export async function runTest(r: TestRequest, o: TestOptions): Promise<{ status: number; ms: number; headers: Record<string, string>; body: string; json?: unknown; truncated: boolean; mutating: boolean }> {
  const method = r.method.toUpperCase(); if (!ALL_METHODS.has(method)) throw new Error(`method ${method} is not supported`);
  if (isMutating(method) && !o.confirmMutating) throw new Error(`${method} changes state: explicit confirmation is required (confirmMutating)`);
  if (!r.path.startsWith("/") || r.path.includes("..") || /[\s\u0000-\u001f]/.test(r.path) || r.path.includes("//")) throw new Error("path must start with / and contain no .., spaces or control characters");
  const base = new URL(o.baseUrl); const q = new URLSearchParams(r.query ?? {}); const full = `${base.origin}${base.pathname.replace(/\/$/, "")}${r.path}${q.toString() ? `?${q}` : ""}`;
  const u = new URL(full); if (u.origin !== base.origin) throw new Error("the request would leave the application's origin");
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "pso-endpoint-tester" };
  for (const [k, v] of Object.entries(r.headers ?? {})) { if (FORBIDDEN_HEADERS.test(k) || /authorization/i.test(k)) continue; if (/[\r\n]/.test(k + v)) throw new Error("header values cannot contain line breaks"); headers[k.toLowerCase()] = v; }
  const loopbackPlain = u.protocol === "http:" && /^(127\.|localhost$|\[::1\]$)/.test(u.hostname);
  if (r.token) { if (u.protocol !== "https:" && !loopbackPlain) throw new Error("a bearer token is never sent over plain HTTP to a non-loopback address"); headers["authorization"] = `Bearer ${r.token}`; }
  const data = r.body === undefined ? undefined : JSON.stringify(r.body); if (data !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(data)); }
  const t0 = Date.now(); const isTls = u.protocol === "https:";
  return new Promise((res, rej) => {
    const opts = { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || (isTls ? 443 : 80)), path: `${u.pathname}${u.search}`, method, headers, timeout: o.timeoutMs ?? 20_000, agent: false as const };
    const cb = (resp: import("node:http").IncomingMessage): void => {
      const chunks: Buffer[] = []; let n = 0; let truncated = false;
      resp.on("data", (d: Buffer) => { n += d.length; if (n <= 256 * 1024) chunks.push(d); else truncated = true; });
      resp.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); const hs: Record<string, string> = {}; for (const [k, v] of Object.entries(resp.headers)) if (!/^(set-cookie|authorization)$/i.test(k)) hs[k] = Array.isArray(v) ? v.join(", ") : String(v ?? ""); let json: unknown; try { json = JSON.parse(text); } catch { /* not JSON */ } res({ status: resp.statusCode ?? 0, ms: Date.now() - t0, headers: hs, body: redactText(text), ...(json !== undefined ? { json } : {}), truncated, mutating: isMutating(method) }); });
    };
    const req = isTls ? request({ ...opts, rejectUnauthorized: true, ...(o.caFile ? { ca: readFileSync(o.caFile) } : {}) }, cb) : httpRequest(opts, cb);
    req.on("timeout", () => { req.destroy(); rej(new Error("the request timed out")); }); req.on("error", (e: NodeJS.ErrnoException) => rej(new Error(CERT_CODES[e.code ?? ""] ? `TLS verification failed (${e.code}): the request was NOT sent (so no token reached an unverified peer)` : redactText(e.message)))); if (data !== undefined) req.write(data); req.end();
  });
}
