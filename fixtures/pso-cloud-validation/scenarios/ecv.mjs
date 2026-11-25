import { WORKSPACE, HOST } from "./config.mjs";
// Strict-TLS test client for the validation (NOT part of PSO): trusts ONLY the private CA, verifies the chain and the IP SAN, no bypass.
import { request } from "node:https";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CA = readFileSync(`${WORKSPACE}/.tls/ca.pem`);
export const TARGET = process.env.ECV_TARGET ?? "tunnel"; // "tunnel" = 127.0.0.1:18443 (SAN includes 127.0.0.1) | "public" = <HOST>:443
const where = TARGET === "public" ? { host: `${HOST}`, port: 443 } : { host: "127.0.0.1", port: 18443 };

export const tokenFor = (scopes, extra = {}) => {
  const r = spawnSync(process.execPath, ["dev-token.mjs", scopes], { cwd: `${WORKSPACE}`, encoding: "utf8", env: { ...process.env, ...extra } });
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
};
export function call(method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body); const t0 = Date.now();
    const req = request({ ...where, method, path, ca: CA, rejectUnauthorized: true, timeout: 20000, ...(process.env.ECV_CLOSE === "1" ? { agent: false } : {}), headers: { ...(process.env.ECV_CLOSE === "1" ? { connection: "close" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const authorized = res.socket ? res.socket.authorized : undefined; let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = undefined; } resolve({ status: res.statusCode, json: j, text: b, ms: Date.now() - t0, headers: res.headers, tls: authorized }); });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); }); req.on("error", reject); if (data) req.write(data); req.end();
  });
}
