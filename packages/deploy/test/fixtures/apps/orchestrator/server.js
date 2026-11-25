// Fixture orchestrator: a zero-dependency Node HTTP service that calls its catalog through the stable internal address.
import http from "node:http";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("./version.json", import.meta.url), "utf8"));
const port = Number(process.env.PORT);
const catalog = process.env.CATALOG_URL;
let inflight = 0, stopping = false;
if (cfg.leak) console.log("startup secret value: " + process.env.DB_PASSWORD);
if (cfg.crash) setTimeout(() => { console.error("fixture: crashing on start as configured"); process.exit(1); }, 300);
const server = http.createServer(async (req, res) => {
  inflight++;
  const done = () => { inflight--; };
  res.on("close", done);
  if (req.url === "/health/ready") { res.statusCode = cfg.notReady ? 503 : 200; return res.end(JSON.stringify({ ok: !cfg.notReady, version: cfg.version })); }
  if (req.url === "/health/live") { return res.end("ok"); }
  if (req.url === "/slow") { await new Promise((r) => setTimeout(r, 1500)); return res.end(JSON.stringify({ service: "orchestrator", version: cfg.version, slow: true })); }
  let items = null;
  try { const r = await fetch(`${catalog}/items`, { signal: AbortSignal.timeout(2000) }); items = await r.json(); } catch (e) { items = { error: String(e.cause?.code ?? e.message) }; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ service: "orchestrator", version: cfg.version, catalog: items }));
});
server.listen(port, "127.0.0.1", () => console.log(`orchestrator ${cfg.version} listening on ${port}`));
process.on("SIGTERM", () => {
  stopping = true; console.log("SIGTERM: draining");
  server.close();
  const t = setInterval(() => { if (inflight <= 0) { clearInterval(t); setTimeout(() => process.exit(0), Number(process.env.SHUTDOWN_DELAY_MS ?? 0)); } }, 50);
});
