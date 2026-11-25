// A stand-in for the orchestrator's loopback listener: echoes what nginx forwarded, and accepts a WebSocket upgrade.
const http = require("node:http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", "x-upstream": "orchestrator" });
  res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, xff: req.headers["x-forwarded-for"] ?? null, proto: req.headers["x-forwarded-proto"] ?? null }));
});
server.on("upgrade", (req, socket) => {
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-upstream-saw-upgrade: ${req.headers.upgrade ?? ""}\r\nx-upstream-url: ${req.url}\r\n\r\n`);
  socket.end();
});
server.listen(3999, "127.0.0.1", () => console.log("upstream ready"));
