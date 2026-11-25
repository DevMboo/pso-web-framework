import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, DispatchConsumer, DispatchError, DispatchConfigError, SIGNATURE_HEADER, signMessage, loadDispatchConfig, createEnvelope, serializeEnvelope,
  type ConsumeContext, type DispatchTrust,
} from "../src/index.ts";
import { MemoryAdapter } from "../src/testing.ts";

/**
 * The production policy of Dispatch publisher identity (SEC-02, security defaults):
 *   - a consumer that acts on WHO published an event declares `requireVerified`; it never runs on a claimed source, in any trust mode;
 *   - production does not start with an unauthenticated Dispatch unless that is declared (PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true);
 *   - the declaration is a compatibility mode for ordinary consumers only: it grants nothing to a privileged consumer.
 */
const K = { billing: "billing-key-".padEnd(40, "b"), rogue: "rogue-key-".padEnd(40, "r"), billingOld: "billing-old-".padEnd(40, "o") };
const CHANNEL = "billing.events";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(10); } };
const trust = (mode: DispatchTrust["mode"], keys: Record<string, string[]>, signingKey?: string): DispatchTrust => ({ mode, keys: new Map(Object.entries(keys)), ...(signingKey ? { signingKey } : {}) });
function runtime(adapter: MemoryAdapter, source: string, t?: DispatchTrust): DispatchRuntime {
  const registry = new EventRegistry();
  registry.add({ name: "billing.invoice-paid", version: 1, channel: CHANNEL });
  return new DispatchRuntime({ settings: { source, ...DEFAULT_SETTINGS, retry: { enabled: false, maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1 }, ...(t ? { trust: t } : {}) }, adapter, registry });
}
const forged = (invoice: string, source = "billing-service"): Buffer => Buffer.from(serializeEnvelope(createEnvelope({ type: "billing.invoice-paid", version: 1, source, payload: { invoice } })));
const reasons = (a: MemoryAdapter): string[] => (a.log.get(`${CHANNEL}.dlq`) ?? []).map((m) => m.headers["x-pso-reason"]!).sort();

for (const mode of ["off", "permissive", "required"] as const) {
  test(`a privileged consumer (requireVerified) with trust mode "${mode}": only a signed, known publisher runs it; an ordinary consumer keeps the mode's behaviour`, async () => {
    const broker = new MemoryAdapter();
    const billing = runtime(broker, "billing-service", trust("off", {}, K.billing));
    const rogue = runtime(broker, "rogue-service", trust("off", {}, K.rogue));
    const ledger = runtime(broker, "ledger-service", trust(mode, { "billing-service": [K.billingOld, K.billing] }));
    const privileged: Array<{ invoice: string; verified: string | undefined }> = [];
    class GrantCredit { handle(p: { invoice: string }, c: ConsumeContext): void { privileged.push({ invoice: p.invoice, verified: c.verifiedSource }); } }
    DispatchConsumer("billing.invoice-paid", { group: "credit", requireVerified: true })(GrantCredit as never);
    ledger.register(new GrantCredit() as never);
    const ordinary: string[] = [];
    ledger.registerFunction("billing.invoice-paid", (p) => { ordinary.push((p as { invoice: string }).invoice); }, { group: "audit" });
    await billing.start(); await rogue.start(); await ledger.start();
    try {
      await billing.publish("billing.invoice-paid", { invoice: "signed" });                                   // signed authorized publisher
      await broker.publishRaw(CHANNEL, forged("unsigned"));                                                  // unsigned publisher claiming billing-service
      const wrong = forged("wrong-key");
      await broker.publishRaw(CHANNEL, wrong, { headers: { [SIGNATURE_HEADER]: signMessage(K.rogue, CHANNEL, wrong) } }); // forged source, incorrect signing key
      await broker.publishRaw(CHANNEL, forged("tampered"), { headers: { [SIGNATURE_HEADER]: signMessage(K.billing, CHANNEL, forged("original")) } }); // tampered envelope
      await rogue.publish("billing.invoice-paid", { invoice: "unknown-producer" });                           // unknown producer, honestly signed
      const old = forged("rotating");
      await broker.publishRaw(CHANNEL, old, { headers: { [SIGNATURE_HEADER]: signMessage(K.billingOld, CHANNEL, old) } });  // key rotation: the previous key still verifies
      await until(() => (broker.log.get(`${CHANNEL}.dlq`) ?? []).length + privileged.length + ordinary.length >= (mode === "off" ? 12 : mode === "permissive" ? 11 : 12));
      await sleep(50);
      assert.deepEqual(privileged, [{ invoice: "signed", verified: "billing-service" }, { invoice: "rotating", verified: "billing-service" }], "the privileged handler ran only for verified publishers");
      const untrusted = ["PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:unknown-source", "PSO_DISPATCH_UNTRUSTED:unsigned"];
      if (mode === "off") {
        assert.deepEqual(ordinary.sort(), ["rotating", "signed", "tampered", "unknown-producer", "unsigned", "wrong-key"], "trust off: ordinary consumers are untouched (compatibility)");
        assert.deepEqual(reasons(broker), untrusted, "what was dead-lettered was refused for the privileged group only");
      } else if (mode === "permissive") {
        assert.deepEqual(ordinary.sort(), ["rotating", "signed", "unknown-producer", "unsigned"], "permissive: unsigned and unknown publishers still reach ordinary consumers, invalid signatures never do");
        assert.deepEqual(reasons(broker), [...untrusted, "PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:invalid"].sort());
      } else {
        assert.deepEqual(ordinary.sort(), ["rotating", "signed"]);
        assert.deepEqual(reasons(broker), [...untrusted, ...untrusted].sort());
      }
    } finally { await ledger.stop(); await billing.stop().catch(() => undefined); await rogue.stop().catch(() => undefined); }
  });
}

test("a privileged consumer without any verification key refuses to START (a clear error, not a queue of dead letters)", async () => {
  for (const t of [undefined, trust("off", {}), trust("permissive", {})]) {
    const rt = runtime(new MemoryAdapter(), "ledger-service", t);
    rt.registerFunction("billing.invoice-paid", () => undefined, { requireVerified: true });
    await assert.rejects(rt.start(), (e: unknown) => e instanceof DispatchError && e.code === "PSO_DISPATCH_TRUST_KEYS" && /requires a verified publisher/.test(e.message) && /PSO_DISPATCH_TRUST_KEY_<SERVICE>/.test(e.message));
  }
  // with a key it starts, in any mode
  const ok = runtime(new MemoryAdapter(), "ledger-service", trust("off", { "billing-service": [K.billing] }));
  ok.registerFunction("billing.invoice-paid", () => undefined, { requireVerified: true });
  await ok.start(); await ok.stop();
});

test("production policy: Dispatch does not start unauthenticated unless that is declared; required mode needs keys; development is unchanged; no key is printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-trust-policy-"));
  const load = (dispatch: Record<string, unknown>, env: Record<string, string> = {}) => { writeFileSync(join(dir, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "redis", redis: { url: "redis://cache:6379" }, ...dispatch } })); return loadDispatchConfig({ projectDir: dir, source: "orders-service", env }); };
  const problem = (dispatch: Record<string, unknown>, env: Record<string, string>): string => { try { load(dispatch, env); return ""; } catch (e) { assert.ok(e instanceof DispatchConfigError); return e.message; } };
  const KEY = "k".repeat(40);
  try {
    // development and tests: exactly as before
    assert.equal(load({}).settings.trust, undefined);
    assert.equal(load({}, { NODE_ENV: "test" }).settings.trust, undefined);

    // production, nothing configured: refused, with the secure path AND the migration switch in the message
    for (const prod of [{ PSO_ENV: "production" }, { NODE_ENV: "production" }]) {
      const m = problem({}, prod);
      assert.match(m, /production requires publisher authentication/);
      assert.match(m, /dispatch\.trust\.mode/);
      assert.match(m, /PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true \(insecure/);
    }
    // a signing key alone does not authenticate what this service CONSUMES: mode off is still off
    assert.match(problem({}, { PSO_ENV: "production", PSO_DISPATCH_SIGNING_KEY: KEY }), /production requires publisher authentication/);

    // secure production
    const secure = load({ trust: { mode: "required" } }, { PSO_ENV: "production", PSO_DISPATCH_SIGNING_KEY: KEY, PSO_DISPATCH_TRUST_KEY_BILLING_SERVICE: KEY });
    assert.equal(secure.settings.trust?.mode, "required");
    // migration step: permissive is accepted in production (unsigned traffic is counted, invalid signatures refused)
    assert.equal(load({ trust: { mode: "permissive" } }, { PSO_ENV: "production", PSO_DISPATCH_SIGNING_KEY: KEY }).settings.trust?.mode, "permissive");

    // explicit legacy: exact value only; the mode stays off (nothing is "verified" by declaration)
    const legacy = load({}, { PSO_ENV: "production", PSO_DISPATCH_ALLOW_UNAUTHENTICATED: "true" });
    assert.equal(legacy.settings.trust?.mode ?? "off", "off");
    for (const sloppy of ["1", "yes", "TRUE"]) assert.match(problem({}, { PSO_ENV: "production", PSO_DISPATCH_ALLOW_UNAUTHENTICATED: sloppy }), /must be exactly "true"/);
    // legacy mode keeps the verification keys that ARE configured, so privileged consumers still verify
    assert.deepEqual([...(load({}, { PSO_ENV: "production", PSO_DISPATCH_ALLOW_UNAUTHENTICATED: "true", PSO_DISPATCH_TRUST_KEY_BILLING_SERVICE: KEY }).settings.trust?.keys.keys() ?? [])], ["billing-service"]);

    // required without any key cannot verify or sign anything: refused everywhere, not only in production
    assert.match(problem({ trust: { mode: "required" } }, {}), /dispatch\.trust\.mode is "required" but no key is configured/);
    // dispatch disabled: nothing to authenticate
    assert.equal(load({ enabled: false }, { PSO_ENV: "production" }).enabled, false);
    // incomplete configuration never downgrades silently: a weak key is an error, not "no key"
    const weak = problem({ trust: { mode: "required" } }, { PSO_ENV: "production", PSO_DISPATCH_SIGNING_KEY: "short-key-value" });
    assert.match(weak, /at least 32 characters/);
    assert.ok(!weak.includes("short-key-value"), "the value is never echoed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
