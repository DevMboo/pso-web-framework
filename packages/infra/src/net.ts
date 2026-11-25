import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

/**
 * One HTTP(S) client for every request PSO itself makes to an environment (probes, token requests, the Studio API Client): real requests,
 * certificate verification always on (against the environment's authority when given), an optional fixed mapping of host names to
 * addresses (local `*.pso.localhost` names resolve to loopback without touching the system's resolver), a hard timeout, cancellation,
 * no automatic redirects and a response size limit.
 */
export interface NetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** PEM authorities to trust (in addition to nothing: the system store is NOT used when this is given) */
  ca?: string | string[];
  /** client certificate for mutual TLS */
  cert?: string;
  key?: string;
  /** host name -> IP address (exact names only) */
  resolve?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}
export interface NetResponse { status: number; statusText: string; headers: Record<string, string | string[]>; body: Buffer; timeMs: number; truncated: boolean; remoteAddress?: string; tls?: { authorized: boolean; protocol?: string; subjectAltName?: string } }

export class NetError extends Error {
  readonly code: string;
  readonly timeMs: number;
  constructor(code: string, message: string, timeMs: number) { super(message); this.code = code; this.timeMs = timeMs; }
}

export function netRequest(o: NetRequest): Promise<NetResponse> {
  const u = new URL(o.url);
  if (u.protocol !== "https:" && u.protocol !== "http:") return Promise.reject(new NetError("PSO_NET_SCHEME", `unsupported scheme ${u.protocol}`, 0));
  const started = performance.now();
  const map = o.resolve ?? {};
  const lookup: LookupFunction = (host, opts, cb) => {
    const fixed = map[host.toLowerCase()];
    if (fixed) { const fam = isIP(fixed) || 4; if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: fixed, family: fam }]); else cb(null, fixed, fam); return; }
    import("node:dns").then((dns) => dns.lookup(host, opts, cb as never)).catch((e: Error) => cb(e as NodeJS.ErrnoException, "", 4));
  };
  const max = o.maxBytes ?? 5 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    const fn = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = fn(u, {
      // one connection per call: a pooled keep-alive socket would outlive a container restart and fail the next call with ECONNRESET
      // (Node keeps connections alive by default); the TLS facts below then also always describe this call's own handshake
      method: o.method ?? "GET", headers: o.headers ?? {}, lookup, timeout: o.timeoutMs ?? 30_000, agent: false,
      ...(u.protocol === "https:" ? { ...(o.ca ? { ca: o.ca } : {}), ...(o.cert ? { cert: o.cert } : {}), ...(o.key ? { key: o.key } : {}), rejectUnauthorized: true, servername: isIP(u.hostname) ? undefined : u.hostname } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    } as never, (res) => {
      const chunks: Buffer[] = []; let size = 0, truncated = false;
      // the TLS facts are read now: after the body the socket may already be back in the pool or closed
      const live = res.socket as unknown as { remoteAddress?: string; authorized?: boolean; getProtocol?: () => string | null; getPeerCertificate?: () => { subjectaltname?: string } } | null;
      const tlsFacts = u.protocol === "https:" && live ? { authorized: live.authorized === true, ...(live.getProtocol?.() ? { protocol: live.getProtocol!()! } : {}), subjectAltName: live.getPeerCertificate?.()?.subjectaltname ?? "" } : undefined;
      const remote = live?.remoteAddress;
      res.on("data", (c: Buffer) => { if (size + c.length > max) { truncated = true; chunks.push(c.subarray(0, Math.max(0, max - size))); size = max; res.destroy(); return; } chunks.push(c); size += c.length; });
      const finish = () => {
        resolvePromise({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: res.headers as Record<string, string | string[]>, body: Buffer.concat(chunks), timeMs: Math.round(performance.now() - started), truncated,
          ...(remote ? { remoteAddress: remote } : {}), ...(tlsFacts ? { tls: tlsFacts } : {}) });
      };
      res.on("end", finish); res.on("close", () => { if (truncated) finish(); });
      res.on("error", (e) => reject(new NetError("PSO_NET_RESPONSE", e.message, Math.round(performance.now() - started))));
    });
    req.on("timeout", () => req.destroy(new NetError("PSO_NET_TIMEOUT", `no response within ${o.timeoutMs ?? 30_000} ms`, Math.round(performance.now() - started))));
    req.on("error", (e: Error & { code?: string }) => reject(e instanceof NetError ? e : new NetError(e.name === "AbortError" ? "PSO_NET_CANCELLED" : (e.code ?? "PSO_NET_ERROR"), e.name === "AbortError" ? "the request was cancelled" : e.message, Math.round(performance.now() - started))));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
