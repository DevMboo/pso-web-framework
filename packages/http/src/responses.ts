import type { IncomingMessage, ServerResponse } from "node:http";
import { buildProblem, kindOf, PROBLEM_CONTENT_TYPE } from "./problem.ts";

/** Answers, then discards the unread request body (bounded) and closes, so the client can always read the status. */
export function sendAndClose(res: ServerResponse, req: IncomingMessage, legacy: string, correlationId: string, status?: number, extra?: { detail?: string; errors?: ReadonlyArray<{ field?: string; message: string }> }): void {
  sendProblem(res, req, legacy, correlationId, status, extra); // no "connection: close": it would reset the socket while the client is still sending, hiding the status
  // let the client finish reading the response: discard what it is still sending, bounded in volume and time, then close
  res.once("finish", () => {
    let discarded = 0;
    const stop = (): void => { clearTimeout(timer); req.destroy(); };
    const timer = setTimeout(stop, 1000);
    timer.unref();
    req.on("data", (c: Buffer) => { discarded += c.length; if (discarded > 1_048_576) stop(); });
    req.once("end", stop);
    req.once("error", stop);
    req.resume();
  });
}

/** Sends a framework error as RFC 9457 Problem Details. `legacy` is a catalog kind or, for an application HttpError, its message. */
export function sendProblem(res: ServerResponse, req: IncomingMessage | undefined, legacy: string, correlationId: string, status?: number, extra: { detail?: string; errors?: ReadonlyArray<{ field?: string; message: string }> } = {}): void {
  if (res.headersSent) return;
  const k = kindOf(legacy);
  const st = k?.status ?? status ?? 500;
  const p = buildProblem(st, legacy, { correlationId, ...(req?.url ? { instance: new URL(req.url, "http://localhost").pathname } : {}), ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.errors?.length ? { errors: extra.errors } : {}) });
  const data = JSON.stringify(p);
  const headers: Record<string, string | number> = { "content-type": PROBLEM_CONTENT_TYPE, "content-length": Buffer.byteLength(data), "x-correlation-id": correlationId, "x-content-type-options": "nosniff", "cache-control": "no-store" };
  if (st === 401) headers["www-authenticate"] = "Bearer";
  res.writeHead(st, headers);
  res.end(data);
}

export function send(res: ServerResponse, status: number, body: unknown, correlationId: string, extraHeaders: Readonly<Record<string, string>> = {}): void {
  if (res.headersSent) return;
  if (status === 204 || status === 304) { // no body, no content headers
    res.writeHead(status, { "x-correlation-id": correlationId, "x-content-type-options": "nosniff", "cache-control": "no-store", ...extraHeaders });
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "x-correlation-id": correlationId, "x-content-type-options": "nosniff", "cache-control": "no-store", ...extraHeaders });
  res.end(data);
}
