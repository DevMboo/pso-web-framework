import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJwks } from "../src/index.ts";
import { keypair, jwkOf, idp } from "./helpers.ts";

/**
 * A JWKS host with several addresses. The defect, found while validating a generated deployment in Docker: only the first address the
 * resolver returned was used. When that was an IPv6 address on a host without an IPv6 route (a container), the connection failed
 * before the request existed, the failure was reported as a permanent error and the orchestrator did not start, depending on the
 * order of a DNS answer. Now every address is still validated, and the validated addresses are tried in turn, IPv4 first.
 */
test("the validated addresses of a JWKS host are tried in turn, and a blocked address still rejects the host", async () => {
  const server = await idp([await jwkOf(await keypair("ES256"))]); // listens on 127.0.0.1 only
  try {
    const src = { kind: "jwks" as const, uri: new URL(`http://localhost:${server.port}/jwks`), timeoutMs: 3000, cacheTtlMs: 600000, cooldownMs: 30000, maxStaleMs: 3600000, maxBytes: 262144, trustedHosts: [], loopbackAllowed: true };
    const run = async (addrs: Array<{ address: string; family: number }>) => { try { return (await fetchJwks(src, { resolver: async () => addrs })).keys.length; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
    // an IPv6 address first, where nothing answers: the IPv4 address is used
    assert.equal(await run([{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }]), 1);
    // a first address that refuses the connection: the next validated address is used
    assert.equal(await run([{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }]), 1);
    assert.equal(server.hits(), 2);
    // no address answers: a transient network error, as before (the caller retries it)
    await assert.rejects(fetchJwks(src, { resolver: async () => [{ address: "127.0.0.2", family: 4 }, { address: "::1", family: 6 }] }), (e: unknown) => (e as { code?: string }).code === "jwks_network" && (e as { transient?: boolean }).transient === true);
    // trying several addresses never weakens the address check: one blocked answer rejects the host and nothing is contacted
    assert.equal(await run([{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }]), "jwks_blocked_address");
    assert.equal(await run([{ address: "169.254.169.254", family: 4 }, { address: "127.0.0.1", family: 4 }]), "jwks_blocked_address");
    assert.equal(server.hits(), 2);
  } finally { await server.close(); }
});
