// Development only: serves keys/jwks.json on loopback so the Spring service can fetch the public key (production uses your identity provider's JWKS URL).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/jwks.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(new URL("./keys/jwks.json", import.meta.url)));
  } else {
    res.writeHead(404).end();
  }
}).listen(8099, "127.0.0.1", () => console.log("JWKS on http://127.0.0.1:8099/jwks.json"));
