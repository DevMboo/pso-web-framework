import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeiManifest, buildRemoteManifest, publishFei, publishMei, ReleaseRefused } from "@pso/frontend/node";
import { releaseSigningFromFlags, withReleaseKey } from "../src/frontend-signing.ts";
import { CliError } from "../src/fsx.ts";
import { pso, tmp } from "./helpers.ts";

/**
 * Microfrontend releases signed with a local signer of `pso signer:generate`: the private key stays in the protected credential store,
 * the manifest carries the signer's key id, and a shell that trusts the signer (`frontend:config --trust-signer`) activates the release
 * while it still refuses unsigned or foreign ones. The credential store here is the encrypted-file provider in a temporary home.
 */
const saved = { home: process.env["PSO_CLOUD_HOME"], provider: process.env["PSO_CREDENTIAL_PROVIDER"], pass: process.env["PSO_CREDENTIAL_PASSPHRASE"] };
const dirs: string[] = [];
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
after(() => { restore("PSO_CLOUD_HOME", saved.home); restore("PSO_CREDENTIAL_PROVIDER", saved.provider); restore("PSO_CREDENTIAL_PASSPHRASE", saved.pass); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SHARED = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };
function meiDist(version: string, signWith?: { keyId: string; privateKeyPem: string }): { dir: string; manifest: ReturnType<typeof buildRemoteManifest> } {
  const dir = tmp("pso-sig-mei-"); dirs.push(dir);
  for (const [n, v] of Object.entries(SHARED)) { mkdirSync(join(dir, "node_modules", ...n.split("/")), { recursive: true }); writeFileSync(join(dir, "node_modules", ...n.split("/"), "package.json"), JSON.stringify({ name: n, version: v })); }
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), `// mei-customers ${version}`); writeFileSync(join(dir, "dist", "assets", "module.js"), `export default "${version}"`);
  const manifest = buildRemoteManifest({ dir, definition: { name: "mei-customers", host: "fei-shop", orchestrator: { service: "shop-gateway" } }, routes: [], version, ...(signWith ? { signWith } : {}) });
  return { dir: join(dir, "dist"), manifest };
}

test("a local signer signs a microfrontend release, the shell trusts it by name, and unsigned or foreign releases stay refused", async () => {
  const home = tmp("pso-sig-home-"); dirs.push(home);
  process.env["PSO_CLOUD_HOME"] = home; process.env["PSO_CREDENTIAL_PROVIDER"] = "encrypted-file"; process.env["PSO_CREDENTIAL_PASSPHRASE"] = "frontend-signer-test-passphrase";
  const base = tmp("pso-sig-ws-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop", "--layout", "flat")).code, 0);
  const root = join(base, "shop");
  assert.equal((await pso(root, "create", "orchestrator", "shop-gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "fei", "shop")).code, 0);
  assert.equal((await pso(root, "create", "mei", "customers", "--register")).code, 0);

  const gen = await pso(root, "signer:generate", "release-bot", "--json"); assert.equal(gen.code, 0, gen.err + gen.out);
  const signer = JSON.parse(gen.out) as { name: string; keyId: string }; assert.match(signer.keyId, /^SHA256:/);
  assert.doesNotMatch(gen.out, /PRIVATE KEY/);

  // the shell's site: an active FEI release and a runtime configuration that requires signatures from the trusted signer
  const site = tmp("pso-sig-site-"); dirs.push(site);
  const fdir = tmp("pso-sig-fei-"); dirs.push(fdir); mkdirSync(join(fdir, "dist", "assets"), { recursive: true });
  writeFileSync(join(fdir, "dist", "index.html"), "<html>shop</html>"); writeFileSync(join(fdir, "dist", "assets", "main-1.js"), "console.log(1)");
  buildFeiManifest({ dir: fdir, definition: { name: "fei-shop", orchestrator: { service: "shop-gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }] }, version: "1.0.0", basePath: "/" });
  publishFei({ site, dist: join(fdir, "dist") });
  const cfg = await pso(root, "frontend:config", "--site", site, "--require-signature", "--trust-signer", "release-bot");
  assert.equal(cfg.code, 0, cfg.err + cfg.out);
  const runtime = readFileSync(join(site, "pso-runtime-config.json"), "utf8");
  const rc = JSON.parse(runtime) as { requireSignature: boolean; trustedKeys: Array<{ keyId: string; publicKey: string }> };
  assert.equal(rc.requireSignature, true); assert.deepEqual(rc.trustedKeys.map((k) => k.keyId), [signer.keyId]);
  assert.doesNotMatch(runtime, /PRIVATE|BEGIN/, "only the raw public key reaches the site");

  // signed through the credential store: the manifest names the signer's key id and the release activates
  const signed = withReleaseKey(releaseSigningFromFlags({ signer: "release-bot" }), "test", (signWith) => meiDist("1.0.0", signWith));
  assert.equal(signed.manifest.signature?.keyId, signer.keyId);
  assert.equal(publishMei({ site, dist: signed.dir }).activated, true);
  const refused = (dist: string, re: RegExp) => assert.throws(() => publishMei({ site, dist }), (e: Error) => e instanceof ReleaseRefused && re.test(`${e.message} ${e.reasons.join(" ")}`), String(re));
  refused(meiDist("1.1.0").dir, /not signed/);
  const foreign = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  refused(meiDist("1.1.0", { keyId: signer.keyId, privateKeyPem: foreign }).dir, /does not match/);
  refused(meiDist("1.1.0", { keyId: "someone-else", privateKeyPem: foreign }).dir, /does not trust/);

  // the use of the private key is audited on this machine; the key itself is never written outside the encrypted store
  const audit = readFileSync(join(home, "audit.jsonl"), "utf8"); assert.match(audit, /signer\.used/);

  // refusals before anything is signed
  assert.throws(() => releaseSigningFromFlags({ signer: "release-bot", "sign-key": "k.pem", "key-id": "x" }), (e: Error) => e instanceof CliError && /use one/.test(e.message));
  assert.throws(() => withReleaseKey(releaseSigningFromFlags({ signer: "nobody" }), "test", () => 0), (e: Error) => e instanceof CliError && /no signer named "nobody"/.test(e.message));
  assert.notEqual((await pso(root, "frontend:config", "--site", site, "--trust-signer", "nobody")).code, 0);
  assert.notEqual((await pso(root, "frontend:build", "--signer", "release-bot", "--sign-key", "k.pem", "--key-id", "x")).code, 0, "two key sources are a usage error");
});
