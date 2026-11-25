// TEST FIXTURE. NOT AN IDENTITY PROVIDER FOR ANY REAL USE.
//
// A synthetic issuer for integration tests of PSO deployments: it publishes a JWKS over HTTPS and signs JWTs for whatever
// identity a test asks for. There is no authentication, no user store and no persistence: the signing keys are generated in
// memory when the process starts and are gone when it stops. Never deploy it, never reuse its keys, never point a production
// configuration at it. It is not part of the framework packages and is not shipped with them.
//
//   env: IDP_ISSUER (required, e.g. https://idp:8443)  IDP_PORT (default 8443)  IDP_CERT, IDP_KEY (PEM files, required)
//   GET  /.well-known/jwks.json     the public keys
//   GET  /healthz
//   POST /token   {"sub","scope","roles":[],"aud","iss","expiresIn":seconds (negative = already expired),"forge":true}
//                 -> {"token"}; "forge" signs with a key that is NOT published (an invalid signature for every verifier)
//   POST /rotate  a new signing key; the previous public key stays published so tokens already issued remain verifiable
"use strict";
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");

const issuer = process.env.IDP_ISSUER;
if (!issuer || !process.env.IDP_CERT || !process.env.IDP_KEY) { console.error("test-idp: IDP_ISSUER, IDP_CERT and IDP_KEY are required"); process.exit(2); }
const b64 = (b) => Buffer.from(b).toString("base64url");
// key ids are unique per process, as a real provider's are: a verifier that cached the keys of an earlier instance sees an unknown id
// (and fetches the key set again) instead of a known id with another key behind it
const instance = crypto.randomBytes(4).toString("hex");
const newKey = (n) => { const kid = `test-${instance}-${n}`; const k = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); return { kid, privateKey: k.privateKey, jwk: { ...k.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" } }; };
const keys = [newKey(1)];
const unpublished = newKey("unpublished");

function sign(claims, key) {
  const head = b64(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid }));
  const body = b64(JSON.stringify(claims));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(sig)}`;
}

const server = https.createServer({ cert: fs.readFileSync(process.env.IDP_CERT), key: fs.readFileSync(process.env.IDP_KEY) }, (req, res) => {
  const send = (status, obj) => { const t = JSON.stringify(obj); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(t), "cache-control": "no-store" }); res.end(t); };
  if (req.method === "GET" && req.url === "/.well-known/jwks.json") return send(200, { keys: keys.map((k) => k.jwk) });
  if (req.method === "GET" && req.url === "/healthz") return send(200, { status: "UP", keys: keys.length, fixture: "test identity provider, not for production" });
  if (req.method === "POST" && req.url === "/rotate") { keys.push(newKey(keys.length + 1)); return send(200, { signingKey: keys[keys.length - 1].kid, published: keys.map((k) => k.kid) }); }
  if (req.method === "POST" && req.url === "/token") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
    req.on("end", () => {
      let o; try { o = JSON.parse(raw || "{}"); } catch { return send(400, { error: "invalid JSON" }); }
      const now = Math.floor(Date.now() / 1000);
      const ttl = Number.isFinite(o.expiresIn) ? o.expiresIn : 300;
      const claims = { iss: o.iss ?? issuer, aud: o.aud ?? "pso-api", sub: o.sub ?? "test-user", iat: now - (ttl < 0 ? 3600 : 0), nbf: now - (ttl < 0 ? 3600 : 5), exp: now + ttl, jti: crypto.randomUUID(), ...(o.scope ? { scope: o.scope } : {}), ...(Array.isArray(o.roles) ? { roles: o.roles } : {}) };
      send(200, { token: sign(claims, o.forge ? unpublished : keys[keys.length - 1]), kid: (o.forge ? unpublished : keys[keys.length - 1]).kid });
    });
    return;
  }
  send(404, { error: "not found" });
});
server.listen(Number(process.env.IDP_PORT ?? 8443), "0.0.0.0", () => console.log(`test-idp (FIXTURE, not for production) listening on ${process.env.IDP_PORT ?? 8443}, issuer ${issuer}`));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => server.close(() => process.exit(0)));
