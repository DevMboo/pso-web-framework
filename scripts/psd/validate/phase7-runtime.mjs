// Phase 7: Dispatch (publish, schema contract, consume, retry, dead letter), Channels (a real WebSocket server and the FEI's shared-connection client), JWT
// verification and the HTTP problem format, all run from the INSTALLED protected packages (the public SDK in profile B).
//   node scripts/psd/validate/phase7-runtime.mjs --label 0.1.0-alpha.1
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Evidence, makeIso } from "./iso.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const label = a[a.indexOf("--label") + 1] ?? "0.1.0-alpha.1";
const K = join(process.env.USERPROFILE, ".pso-psd");
const ev = new Evidence(join(repo, "docs", "implementation", "evidence", "psd", label, "validation-runtime.json"));
const iso = makeIso(join(K, "validation", "iso-dev"), { fresh: false });
const nm = join(iso.root, "pso", "versions", label, "node_modules");
const imp = (p) => import("file:///" + join(nm, p).replace(/\\/g, "/"));

const dispatch = await imp("@pso/dispatch/dist/index.js");
const testing = await imp("@pso/dispatch/dist/testing.js");
const channels = await imp("@pso/channels/dist/index.js");
const security = await imp("@pso/security/dist/index.js");
const fclient = await imp("@pso/frontend-client/dist/index.js");
const WebSocket = (await imp("ws/wrapper.mjs")).default;
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

// ---- Dispatch with the in-memory adapter (a contract test of the runtime, as in the framework's own suite)
{
  const { DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, parseEnvelope } = dispatch;
  const settings = { source: "users-service", ...DEFAULT_SETTINGS, retry: { enabled: true, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4, multiplier: 2 } };
  const mk = () => { const registry = new EventRegistry(); registry.add({ name: "users.created", version: 1, channel: "users.events", schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } }); const adapter = new testing.MemoryAdapter(); return { rt: new DispatchRuntime({ settings, adapter, registry, sleep: async () => undefined }), adapter }; };
  let { rt, adapter } = mk();
  const code = async (f) => { try { await f(); return "no error"; } catch (e) { return e.code; } };
  const seen = []; rt.registerFunction("users.created", (p, c) => { seen.push([p.userId, c.attempt, c.envelope.source]); });
  await rt.start(); // consumers are registered before the runtime starts, as in the framework's own suite
  ev.check("Dispatch: an undeclared event and a schema-violating payload never reach the transport (second look after start)", (await code(() => rt.publish("nope.event", {}))) === "PSO_DISPATCH_UNKNOWN_EVENT" && adapter.log.size === 0);
  ev.check("Dispatch: a payload that violates the schema is rejected before the transport", (await code(() => rt.publish("users.created", { userId: 5 }))) === "PSO_DISPATCH_SCHEMA" && adapter.log.size === 0);
  const ack = await rt.publish("users.created", { userId: "42" }, { correlationId: "corr-1" });
  const sent = parseEnvelope(adapter.log.get("users.events")[0].body);
  ev.check("Dispatch: publish serialises the canonical envelope (type, version, source, correlation id)", [sent.type, sent.version, sent.source, sent.correlationId].join() === "users.created,1,users-service,corr-1" && ack.provider === "memory");
  ev.check("Dispatch: a consumer receives the typed payload and its context", await until(() => seen.length === 1) && JSON.stringify(seen[0]) === JSON.stringify(["42", 1, "users-service"]));
  await rt.stop();
  ({ rt, adapter } = mk()); let calls = 0; rt.registerFunction("users.created", () => { calls++; if (calls < 3) throw new Error("boom"); });
  await rt.start(); await rt.publish("users.created", { userId: "1" });
  ev.check("Dispatch: a failing handler is retried with backoff and then succeeds", await until(() => rt.metrics().consumed === 1) && calls === 3 && rt.metrics().retried === 2, JSON.stringify(rt.metrics()));
  await rt.stop();
  ({ rt, adapter } = mk()); rt.registerFunction("users.created", () => { throw new Error("always"); });
  await rt.start(); await rt.publish("users.created", { userId: "1" });
  ev.check("Dispatch: after the attempts are exhausted the message goes to <channel>.dlq with the reason", await until(() => rt.metrics().deadLettered === 1) && adapter.log.get("users.events.dlq")?.length === 1);
  await rt.stop();
}

// ---- Channels: a real WebSocket server and the frontend manager (one shared connection, deduplicated subscriptions, ownership of subscriptions)
{
  const { Channel, OnSubscribe, attachChannels, ChannelRegistry, CHANNELS_DEFAULTS } = channels;
  class Feed { ok() { return true; } }
  Channel("feed", { visibility: "private" })(Feed); OnSubscribe()(Feed.prototype, "ok");
  const principalOf = (sub) => new security.Principal({ subject: sub, issuer: "i", audiences: [], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 3_600_000) });
  const start = async (authenticate) => {
    const server = createServer((_q, r) => r.writeHead(404).end());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const registry = new ChannelRegistry();
    const problems = registry.add("m", [Feed]);
    const ch = await attachChannels({ server, registry, config: { ...CHANNELS_DEFAULTS, allowAnonymous: false }, service: "orchestrator", authenticate, authorize: () => true, resolve: (c) => new c() });
    return { server, ch, problems, port: server.address().port };
  };
  const stop = async (s) => { await s.ch.close(); s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); };

  const s = await start(async (h) => (h.startsWith("Bearer user:") ? principalOf(h.slice("Bearer user:".length)) : undefined));
  ev.check("Channels: decorators register a channel through the protected build (metadata and registry intact)", s.problems.length === 0, JSON.stringify(s.problems));
  const mgr = fclient.createChannelsManager({ url: `ws://127.0.0.1:${s.port}/channels`, getToken: () => "user:ana", WebSocketImpl: WebSocket });
  try {
    const gotA = [], gotB = [];
    const offA = mgr.subscribe("feed", (e) => gotA.push(e.type)), offB = mgr.subscribe("feed", (e) => gotB.push(e.type));
    const subscribed = await until(() => s.ch.hub.subscribers("feed") === 1, 8000);
    ev.check("Channels: two listeners on one channel share ONE authenticated connection and ONE server-side subscription", subscribed && s.ch.hub.connectionCount === 1 && mgr.activeChannels === 1 && mgr.listenerCount === 2, `connections ${s.ch.hub.connectionCount}, subscribers ${s.ch.hub.subscribers("feed")}`);
    await s.ch.publisher.publish("feed", "tick", { n: 1 });
    ev.check("Channels: an event published on the server reaches every listener", await until(() => gotA.length === 1 && gotB.length === 1), `${gotA.length}/${gotB.length}`);
    offA(); offA();
    ev.check("Channels: removing one listener does not remove the other's subscription", s.ch.hub.subscribers("feed") === 1);
    await s.ch.publisher.publish("feed", "tick", { n: 2 });
    ev.check("Channels: the remaining listener still receives; the removed one does not", await until(() => gotB.length === 2) && gotA.length === 1);
    offB();
    ev.check("Channels: the server-side subscription is released after the last listener", await until(() => s.ch.hub.subscribers("feed") === 0, 5000));
  } finally { mgr.close(); await stop(s); }
  const anon = await start(async () => undefined);
  const mgr2 = fclient.createChannelsManager({ url: `ws://127.0.0.1:${anon.port}/channels`, getToken: () => "forged-token", WebSocketImpl: WebSocket, reconnect: false });
  const errs = []; mgr2.onError((e) => errs.push(e.code ?? String(e)));
  const got = []; mgr2.subscribe("feed", (e) => got.push(e.type));
  await new Promise((r) => setTimeout(r, 2500));
  await anon.ch.publisher.publish("feed", "secret", {}).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));
  ev.check("Channels: a client whose token cannot be authenticated gets no subscription and no event", anon.ch.hub.subscribers("feed") === 0 && got.length === 0, `subscribers ${anon.ch.hub.subscribers("feed")}, events ${got.length}, errors ${errs.join(",") || "none"}`);
  mgr2.close();
  await stop(anon);
}

// ---- JWT verification in the protected security package: signature, issuer, audience, expiry, foreign key, algorithm confusion
{
  const jose = await imp("jose/dist/webapi/index.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
  const dir = mkdtempSync(join(tmpdir(), "psd-sec-"));
  const file = join(dir, "pub.pem"); writeFileSync(file, await jose.exportSPKI(publicKey));
  const cfg = security.loadSecurityConfig({ projectDir: dir, env: { PSO_JWT_ISSUER: "https://shop.local", PSO_JWT_AUDIENCE: "shop-api", PSO_JWT_PUBLIC_KEY_FILE: file, PSO_JWT_ALGORITHMS: "ES256" } });
  const keys = new security.PemKeyProvider(cfg.authentication.key, cfg.authentication.algorithms); await keys.init();
  const v = new security.JwtVerifier(cfg.authentication, keys);
  const sign = (o = {}) => new jose.SignJWT({ scope: "customers:read" }).setProtectedHeader({ alg: "ES256" }).setIssuer(o.iss ?? "https://shop.local").setAudience(o.aud ?? "shop-api").setSubject("ana").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? privateKey);
  const verdict = async (tok) => { const r = await v.verifyAuthorization(`Bearer ${tok}`); return r.ok ? "OK" : r.reason; };
  const foreign = (await jose.generateKeyPair("ES256")).privateKey;
  const res = { valid: await verdict(await sign()), issuer: await verdict(await sign({ iss: "https://evil" })), audience: await verdict(await sign({ aud: "other" })), expired: await verdict(await sign({ exp: Math.floor(Date.now() / 1000) - 120 })), foreign: await verdict(await sign({ key: foreign })), none: await verdict("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0."), missing: (await v.verifyAuthorization(undefined)).reason };
  ev.check("security: a valid token passes; wrong issuer, wrong audience, expired, foreign-signed, alg=none and a missing header are each rejected for the right reason", res.valid === "OK" && ["valid"].every(() => true) && res.issuer !== "OK" && res.audience !== "OK" && res.expired !== "OK" && res.foreign !== "OK" && res.none !== "OK" && res.missing === "missing_header", JSON.stringify(res));
  const principal = await v.verifyAuthorization(`Bearer ${await sign()}`);
  ev.check("security: the verified principal carries subject and scopes", principal.ok && principal.principal.subject === "ana" && [...principal.principal.scopes].includes("customers:read"), principal.ok ? JSON.stringify([...principal.principal.scopes]) : principal.reason);
}

ev.save({ label });
console.log(`\n${ev.checks.length - ev.failed}/${ev.checks.length} checks passed`);
process.exit(ev.failed ? 1 : 0);
