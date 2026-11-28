// Stub upstream for the edge's real-nginx test (runs in node:24-alpine on the test's private Docker network). ROLE selects what it plays:
//   orchestrator  HTTPS: Problem Details with WWW-Authenticate / Retry-After / Allow / X-Correlation-ID, technology headers, a WebSocket upgrade
//   fei           HTTP 8080: the shell's static server, including nginx's own error bodies and Server header (what the edge must never pass on)
//   idp           HTTPS 8443: an identity provider (discovery document, login page)
//   silent        TCP: accepts connections and never answers (the edge must time out with 504)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import { createServer as tcp } from "node:net";

const role = process.env.ROLE;
const port = Number(process.env.PORT);
const tls = () => ({ cert: readFileSync("/run/pso/tls/tls.crt"), key: readFileSync("/run/pso/tls/tls.key") });
const problem = (res, status, title, extra = {}) => {
  const body = JSON.stringify({ type: `urn:pso:problem:${title.toLowerCase().replace(/ /g, "-")}`, title, status, detail: "safe detail from the application", code: `APP_${status}`, correlationId: "c-123" });
  res.writeHead(status, { "content-type": "application/problem+json", "x-correlation-id": "c-123", "x-powered-by": "Express", server: "Kestrel", ...extra });
  res.end(body);
};
const NGINX_404 = "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.27.5</center>\r\n</body>\r\n</html>\r\n";

if (role === "orchestrator") {
  const s = https(tls(), (req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/health/ready") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"status":"ready"}'); }
    if (p === "/problem/401") return problem(res, 401, "Authentication required", { "www-authenticate": 'Bearer realm="api", error="invalid_token"' });
    if (p === "/problem/403") return problem(res, 403, "Access denied");
    if (p === "/limited") return problem(res, 429, "Too many requests", { "retry-after": "7" });
    if (p === "/method") return problem(res, 405, "Method not allowed", { allow: "GET, POST" });
    if (p === "/crash") return problem(res, 500, "Internal error");
    if (p === "/unavailable") return problem(res, 503, "Server busy", { "retry-after": "3" });
    if (p === "/powered") { res.writeHead(200, { "content-type": "application/json", "x-powered-by": "Express", server: "Kestrel", "x-aspnet-version": "4.0" }); return res.end('{"ok":true}'); }
    return problem(res, 404, "Resource not found");
  });
  s.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: pso.channels.v1\r\n\r\n`);
    socket.write(Buffer.from([0x81, 0x05, ...Buffer.from("ready")]));
    setTimeout(() => socket.destroy(), 2000);
  });
  s.listen(port);
} else if (role === "fei") {
  http((req, res) => {
    const p = req.url.split("?")[0];
    if (p.endsWith("missing.js")) { res.writeHead(404, { "content-type": "text/html", server: "nginx/1.27.5" }); return res.end(NGINX_404); }
    if (p === "/denied") { res.writeHead(403, { "content-type": "text/html", server: "nginx/1.27.5" }); return res.end(NGINX_404.replace(/404 Not Found/g, "403 Forbidden")); }
    if (req.method === "POST") { res.writeHead(405, { "content-type": "text/html", server: "nginx/1.27.5" }); return res.end(NGINX_404.replace(/404 Not Found/g, "405 Not Allowed")); }
    res.writeHead(200, { "content-type": "text/html", server: "nginx/1.27.5" });
    res.end(`<!doctype html><title>${process.env.NAME}</title><div id="root">shell ${process.env.NAME} ${p}</div>`);
  }).listen(8080);
} else if (role === "idp") {
  https(tls(), (req, res) => {
    if (req.url.includes("/.well-known/openid-configuration")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"issuer":"stub"}'); }
    res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Sign in</title><form id=kc-form-login></form>");
  }).listen(8443);
} else if (role === "silent") {
  tcp(() => { /* accepted, never answered */ }).listen(port);
}
