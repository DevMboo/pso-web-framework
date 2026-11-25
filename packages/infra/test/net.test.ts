import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { netRequest } from "../src/net.ts";

// A call never reuses a pooled keep-alive connection: one that outlived a restart of the container behind it would fail the next call
// with ECONNRESET (what `pso docker:up` after `docker:down` caused in a long-running process such as Studio).
test("every netRequest opens its own connection (no keep-alive reuse across calls)", async () => {
  const ports: number[] = [];
  const server = createServer({ keepAliveTimeout: 60_000 }, (req, res) => { ports.push(req.socket.remotePort ?? 0); res.setHeader("connection", "keep-alive"); res.end("ok"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await netRequest({ url: `http://127.0.0.1:${port}/`, timeoutMs: 5_000 })).status, 200);
    assert.equal(new Set(ports).size, 3, `three calls, three connections (client ports ${ports.join(", ")})`);
  } finally { server.closeAllConnections(); server.close(); }
});
