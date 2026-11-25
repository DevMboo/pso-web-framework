import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText, redactValue, registerSecret } from "../src/redact.ts";
import { CredentialStoreError, EncryptedFileProvider, MemoryCredentialProvider, resolveCredentialProvider } from "../src/credentials.ts";
import { parseDeclaration } from "../src/static-load.ts";
import { validateDeployment, validatePipeline, type DeploymentDecl } from "../src/declare.ts";
import { buildPlan, resolvePipeline, MANDATORY_INVARIANTS } from "../src/agent/plan.ts";
import { renderConfig, isManagedBy, planProxyChange, findConflicts, targetFor } from "../src/agent/nginx.ts";
import { defaultPolicy } from "../src/agent/state.ts";
import { canonical, generateIdentity, signText, verifyText } from "../src/crypto.ts";
import { sshBaseArgs, validateConnectionShape } from "../src/ssh.ts";
import type { Inspection } from "../src/agent/inspect.ts";

const decl = (over: Record<string, unknown> = {}): DeploymentDecl => ({
  name: "shop", environment: "production", connection: { provider: "ssh", credentials: "prod" }, source: { provider: "git", url: "https://example.test/shop.git", branch: "main" },
  service: { name: "web", runtime: "node", start: ["node", "server.js"], shutdownGraceSeconds: 20, route: { path: "/" } }, strategy: { type: "blue-green", proxy: "nginx", rollback: true }, proxy: { nginx: { domains: ["shop.example.test"] } }, ...over,
}) as DeploymentDecl;
const errs = (d: unknown) => validateDeployment(d).filter((x) => x.level === "error").map((x) => x.code);

test("redaction: patterns, keys and registered secrets; URL userinfo, bearer headers, PEM keys, tokens", () => {
  registerSecret("hunter2-the-registered-one");
  const out = redactText("clone https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git; Authorization: Bearer abc.def.ghi; pw hunter2-the-registered-one; -----BEGIN PRIVATE KEY-----\nMIIBVQ\n-----END PRIVATE KEY----- token=abcd1234 ok");
  for (const leak of ["ghp_abcdef", "abc.def.ghi", "hunter2-the", "MIIBVQ", "abcd1234"]) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  assert.match(out, /github\.com\/x\.git/);
  const v = redactValue({ password: "p", nested: { apiKey: "k", note: "Bearer zzz.yyy.xxx", fingerprint: "SHA256:abc" }, list: [{ privateKey: "pk" }], credentials: "prod", publicKeyPem: "ok" }) as any;
  assert.equal(v.password, "[REDACTED]"); assert.equal(v.nested.apiKey, "[REDACTED]"); assert.equal(v.list[0].privateKey, "[REDACTED]"); assert.equal(v.nested.fingerprint, "SHA256:abc"); assert.equal(v.credentials, "prod");
});

test("credentials: the encrypted file provider is AES-GCM, rejects tampering and a wrong passphrase, and nothing falls back to plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-cred-")); const file = join(dir, "c.json");
  const p = new EncryptedFileProvider(file, () => ({ passphrase: "correct horse battery staple" }));
  p.set("cred_a", "s3cret-value"); assert.equal(p.get("cred_a"), "s3cret-value");
  const raw = readFileSync(file, "utf8"); assert.ok(!raw.includes("s3cret-value"), "never plaintext on disk");
  assert.throws(() => new EncryptedFileProvider(file, () => ({ passphrase: "wrong passphrase wrong" })).get("cred_a"), CredentialStoreError);
  const tampered = JSON.parse(raw); tampered.entries.cred_a.ct = Buffer.from("tampered!!").toString("base64"); writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => p.get("cred_a"), /could not be decrypted/);
  assert.equal(new EncryptedFileProvider(join(dir, "x.json"), () => ({ passphrase: "short" })).availability().ok, false);
  assert.equal(p.remove("cred_a"), true);
  // explicit configuration is required; with nothing available the call fails with instructions instead of degrading
  assert.throws(() => resolveCredentialProvider({ home: dir, env: { PSO_CREDENTIAL_PROVIDER: "encrypted-file" }, platform: "linux" }), /No protected credential store is available/);
  assert.throws(() => resolveCredentialProvider({ home: dir, env: {}, platform: "linux" }), /never stores secrets in plain text|PSO never stores/);
  assert.throws(() => resolveCredentialProvider({ home: dir, env: { PSO_CREDENTIAL_PROVIDER: "plaintext" }, platform: "linux" }), /unknown PSO_CREDENTIAL_PROVIDER/);
  assert.equal(resolveCredentialProvider({ home: dir, env: { PSO_CREDENTIAL_PROVIDER: "encrypted-file", PSO_CREDENTIAL_PASSPHRASE: "a long enough passphrase" }, platform: "linux" }).id, "encrypted-file");
  assert.ok(new MemoryCredentialProvider().availability().ok);
});

test("crypto: Ed25519 signatures verify, canonical JSON is order independent", () => {
  const k = generateIdentity(); const sig = signText(k.privateKey, "m");
  assert.equal(verifyText(k.publicKey, "m", sig), true); assert.equal(verifyText(k.publicKey, "n", sig), false); assert.equal(verifyText(generateIdentity().publicKey, "m", sig), false);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test("declarations are read as data: literals only, no code is executed", () => {
  const ok = parseDeclaration(`import { defineDeployment } from "@pso/deploy";\nexport default defineDeployment({ name: "x", n: -3, flag: true, list: ["a", \`b\`], nested: { k: null } } as const);`, "d.ts");
  assert.deepEqual(ok.diagnostics, []); assert.equal(ok.kind, "deployment"); assert.deepEqual(ok.value, { name: "x", n: -3, flag: true, list: ["a", "b"], nested: { k: null } });
  for (const bad of ['export default defineDeployment({ a: process.env.X });', 'const x = 1; export default defineDeployment({ a: x });', 'export default defineDeployment({ ...other });', 'export default defineDeployment({ a: fetch("http://x") });', 'export default evil({ a: 1 });', 'export const x = 1;']) {
    const r = parseDeclaration(bad, "d.ts"); assert.ok(r.diagnostics.some((d) => d.level === "error"), bad);
  }
  let ran = false; (globalThis as any).__ran = () => { ran = true; }; parseDeclaration('export default defineDeployment({ a: __ran() });', "d.ts"); assert.equal(ran, false, "the code in the declaration was not run");
});

test("declaration validation: credentials, strategies, sources and argv are checked", () => {
  assert.deepEqual(errs(decl()), []);
  assert.ok(errs(decl({ source: { provider: "git", url: "https://user:tok3n@example.test/x.git", branch: "m" } })).includes("PSO-DEC-SECRET"), "credentials in a URL");
  assert.ok(errs(decl({ source: { provider: "git", url: "https://example.test/x.git" } })).includes("PSO-DEC-SOURCE"), "no ref");
  assert.ok(errs(decl({ source: { provider: "git", url: "https://example.test/x.git", branch: "a", tag: "b" } })).includes("PSO-DEC-SOURCE"), "two refs");
  assert.ok(errs(decl({ source: { provider: "git", url: "https://example.test/x.git", commit: "abc123" } })).includes("PSO-DEC-SOURCE"), "short commit");
  assert.ok(errs(decl({ service: { name: "web", runtime: "node", start: "node server.js" } })).includes("PSO-DEC-ARGV"), "shell string");
  assert.ok(errs(decl({ service: { name: "web", runtime: "node", start: ["node"], env: { TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123" } } })).includes("PSO-DEC-SECRET"));
  assert.ok(errs(decl({ service: { name: "web", runtime: "node", start: ["node"], secrets: { DB: "has space" } } })).includes("PSO-DEC-SECRET"));
  assert.ok(errs(decl({ strategy: { type: "blue-green", proxy: "none" } })).includes("PSO-DEC-STRATEGY"), "blue-green without a proxy is refused, not downgraded");
  assert.ok(errs(decl({ strategy: { type: "rolling", proxy: "nginx" } })).includes("PSO-DEC-STRATEGY"), "rolling with one instance");
  assert.ok(errs(decl({ strategy: { type: "recreate", proxy: "none" } })).includes("PSO-DEC-STRATEGY"), "downtime must be acknowledged");
  assert.ok(errs(decl({ service: { name: "web", runtime: "node", start: ["node"], dir: "../etc" } })).includes("PSO-DEC-PATH"));
  assert.ok(errs(decl({ connection: { provider: "aws", credentials: "x" } })).includes("PSO-DEC-CONN"), "an unimplemented provider is not accepted");
  assert.ok(errs(decl({ services: [{ name: "a", runtime: "node", start: ["n"] }], service: { name: "b", runtime: "node", start: ["n"] } })).includes("PSO-DEC-SERVICES"));
  assert.ok(errs(decl({ environment: "Prod!" })).includes("PSO-DEC-ENV"));
});

test("pipelines: stages are validated; the mandatory protections are not stages and cannot be switched off", () => {
  const p = (stages: unknown[]) => validatePipeline({ name: "p", stages }).filter((x) => x.level === "error").map((x) => x.code);
  assert.deepEqual(p([{ type: "build" }, { type: "deploy" }]), []);
  assert.ok(p([{ type: "deploy", enabled: false }]).includes("PSO-PIPE-STAGE"), "deploy cannot be disabled");
  assert.ok(p([{ type: "resources", onFailure: "continue" }, { type: "deploy" }]).includes("PSO-PIPE-STAGE"));
  assert.ok(p([{ type: "custom" }, { type: "deploy" }]).includes("PSO-PIPE-STAGE"), "custom stage needs an argv command");
  assert.ok(p([{ type: "build", dependsOn: ["nope"] }, { type: "deploy" }]).includes("PSO-PIPE-DEPENDS"));
  assert.ok(p([{ type: "build", id: "a", dependsOn: ["b"] }, { type: "tests", id: "b", dependsOn: ["a"] }, { type: "deploy" }]).includes("PSO-PIPE-CYCLE"));
  assert.ok(p([{ type: "build" }, { type: "build" }, { type: "deploy" }]).includes("PSO-PIPE-STAGE"), "duplicate ids");
  assert.ok(resolvePipeline(decl(), { name: "p", stages: [{ type: "deploy" }, { type: "build" }] }).errors.some((e) => /last stage/.test(e)));
  assert.ok(validatePipeline({ name: "p", stages: [{ type: "integrity", enabled: false }, { type: "deploy" }] }).some((d) => d.code === "PSO-PIPE-MANDATORY" && d.level === "warning"), "disabling integrity warns that the core still runs");
  assert.ok(MANDATORY_INVARIANTS.some((m) => /candidate readiness/.test(m)) && MANDATORY_INVARIANTS.some((m) => /deployment lock/.test(m)));
});

const insp = (over: Partial<Inspection> = {}): Inspection => ({
  agent: { version: "0", mode: "protected", environmentId: "env_1", home: "/h" }, os: { platform: "linux", release: "", arch: "x64", distro: "Alpine" }, user: { name: "pso", uid: 1000, root: false }, cpu: { count: 2 }, memory: { totalMb: 4096, availableMb: 3000 }, disk: { path: "/h", totalMb: 20000, freeMb: 15000 },
  tools: { node: { available: true, version: "24.0.0" }, java: { available: true, version: "21.0.1" }, git: { available: true, version: "2.4" }, nginx: { available: true, version: "1.2" }, docker: { available: false }, systemd: { available: false }, npm: { available: true }, sudo: { available: true } },
  listeningPorts: [], nginx: { vhosts: [], configValid: true, managedDir: "/etc/nginx/pso.d", managedDirWritable: true }, pso: { apps: [], agentHome: "/h" }, capabilities: [], blockers: [], ...over,
});
const planFor = (d: DeploymentDecl, i = insp(), extra: Record<string, unknown> = {}) => buildPlan({ decl: d, pipeline: undefined, policy: defaultPolicy("protected"), inspection: i, environmentId: "env_1", currentRelease: "r1", source: { provider: "git", url: "u", ref: "main", refType: "branch", commit: "a".repeat(40) }, declaredEnvironmentOfServer: "production", hasPreviousRelease: true, releaseId: "r2", nginxConflicts: [], nginxTarget: "/etc/nginx/pso.d/pso-shop.conf", nginxAction: "update", lockHeld: false, ...extra });

test("plans: bound by hash, explicit about downtime, blocked (never silently downgraded) when the server cannot do the strategy", () => {
  const p = planFor(decl()); assert.deepEqual(p.blockers, []); assert.equal(p.availability.impact, "none expected"); assert.equal(p.strategy.type, "blue-green");
  assert.equal(planFor(decl()).hash, p.hash, "the same inputs give the same hash"); assert.notEqual(planFor(decl({ strategy: { type: "blue-green", proxy: "nginx", rollback: false } })).hash, p.hash);
  assert.ok(p.mandatory.length >= 8 && p.stages.some((s) => s.type === "deploy") && p.rollback.eligible);
  assert.ok(planFor(decl({ environment: "staging" })).blockers.some((b) => /environments are never mixed/.test(b)), "a staging declaration cannot target the production server");
  assert.ok(planFor(decl(), insp({ tools: { ...insp().tools, nginx: { available: false } } })).blockers.some((b) => /nginx is not installed/.test(b)));
  assert.ok(planFor(decl(), insp({ memory: { totalMb: 1000, availableMb: 100 } })).blockers.some((b) => /not enough free memory/.test(b)));
  assert.ok(planFor(decl(), insp({ nginx: { vhosts: [], configValid: false, managedDir: "/x", managedDirWritable: true } })).blockers.some((b) => /nginx -t/.test(b)));
  assert.ok(planFor(decl(), insp(), { lockHeld: true }).blockers.some((b) => /lock held/.test(b)));
  assert.ok(planFor(decl(), insp(), { nginxConflicts: ["x.conf already serves a.example"] }).blockers.some((b) => /already serves/.test(b)));
  const rec = planFor(decl({ strategy: { type: "recreate", proxy: "none", downtimeAcknowledged: true }, proxy: undefined, service: { name: "web", runtime: "node", start: ["node"], port: 8080 } })); assert.equal(rec.availability.impact, "downtime"); assert.match(rec.availability.summary, /stopped before the new one starts/);
  const pol = defaultPolicy("protected"); pol.allowedStrategies = ["recreate"]; assert.ok(buildPlan({ ...({} as never), decl: decl(), pipeline: undefined, policy: pol, inspection: insp(), environmentId: "env_1", currentRelease: null, source: { provider: "git", url: "u", ref: "m", refType: "branch", commit: "b".repeat(40) }, declaredEnvironmentOfServer: "production", hasPreviousRelease: false, releaseId: "r", nginxConflicts: [], nginxTarget: undefined, nginxAction: undefined, lockHeld: false }).blockers.some((b) => /does not allow the "blue-green"/.test(b)), "server policy overrides the project");
});

test("plans record every disabled check, and a destructive migration needs approval and server permission", () => {
  const lax = { name: "lax", stages: [{ type: "integrity", enabled: false }, { type: "security", enabled: false }, { type: "tests", enabled: false }, { type: "deploy" }] };
  const p = buildPlan({ decl: decl(), pipeline: lax as never, policy: defaultPolicy("protected"), inspection: insp(), environmentId: "env_1", currentRelease: null, source: { provider: "git", url: "u", ref: "m", refType: "branch", commit: "c".repeat(40) }, declaredEnvironmentOfServer: "production", hasPreviousRelease: false, releaseId: "r", nginxConflicts: [], nginxTarget: undefined, nginxAction: undefined, lockHeld: false });
  const names = p.disabledChecks.map((d) => d.stage); for (const n of ["integrity", "security", "tests", "compatibility", "build", "health"]) assert.ok(names.includes(n), `${n} is recorded as disabled or omitted`);
  assert.ok(p.warnings.some((w) => /security stage is disabled/.test(w)));
  const m = planFor(decl({ migrations: { mode: "expand-contract", command: ["migrate"], destructive: true } })); assert.ok(m.blockers.some((b) => /not approved/.test(b)) && m.blockers.some((b) => /does not allow destructive/.test(b)));
  assert.ok(m.migrations.destructive && m.rollback.notes.some((n) => /database changes/.test(n)));
  const c = planFor(decl({ services: [{ name: "a", runtime: "node", start: ["n"], consumes: { b: "2.0" } }, { name: "b", runtime: "node", start: ["n"], contract: "1.4" }], service: undefined })); assert.ok(c.blockers.some((b) => /contract incompatibility/.test(b)));
});

test("nginx: managed files carry an owner marker, unrelated files are never overwritten, conflicts are found", () => {
  const input = { app: "shop", release: "r2", nginx: { domains: ["shop.example.test"], listen: { http: 80 } }, services: [{ service: "web", ports: [20001, 20002], stablePort: 21001, route: { path: "/" } }, { service: "catalog", ports: [20003], stablePort: 21002 }] };
  const conf = renderConfig(input);
  assert.ok(isManagedBy(conf, "shop") && !isManagedBy(conf, "other")); assert.match(conf, /# pso-release: r2/); assert.match(conf, /upstream pso_shop_web \{[^}]*20001[^}]*20002/s);
  assert.match(conf, /listen 127\.0\.0\.1:21002;/, "internal services get a loopback listener only"); assert.match(conf, /add_header X-PSO-Release r2 always;/);
  assert.match(conf, /proxy_set_header Upgrade/, "websocket forwarding is on by default"); assert.doesNotMatch(conf, /pso-agent|\bserve\b|management|stdio/i, "the management plane is never published");
  assert.doesNotMatch(conf, /listen (0\.0\.0\.0:)?(2\d{4})\b/, "no upstream port is exposed publicly");
  const tls = renderConfig({ ...input, nginx: { domains: ["a.test"], listen: { http: 80, https: 443 }, tls: { certificate: "/c.pem", key: "/k.pem" } } }); assert.match(tls, /return 301 https/); assert.match(tls, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  const dir = mkdtempSync(join(tmpdir(), "pso-ng-")); const t = { file: join(dir, "pso-shop.conf") };
  assert.equal(planProxyChange(t, "shop", conf).action, "create"); writeFileSync(t.file, conf); assert.equal(planProxyChange(t, "shop", conf.replace(/# generated:.*/, "# generated: later")).action, "unchanged");
  writeFileSync(t.file, "server { listen 80; server_name mine.test; }"); assert.equal(planProxyChange(t, "shop", conf).action, "conflict", "a file PSO does not own is never overwritten");
  writeFileSync(t.file, conf.replace("(app=shop)", "(app=other)")); assert.equal(planProxyChange(t, "shop", conf).action, "conflict", "another app's file is not overwritten either");
  assert.deepEqual(targetFor(defaultPolicy("development"), "shop"), { file: "/etc/nginx/pso.d/pso-shop.conf" });
  assert.deepEqual(targetFor(defaultPolicy("development"), "shop", "sites"), { file: "/etc/nginx/sites-available/pso-shop.conf", link: "/etc/nginx/sites-enabled/pso-shop.conf" });
  assert.throws(() => targetFor(defaultPolicy("development"), "shop", "../etc"), /unknown nginx layout/);
  assert.equal(findConflicts({ serverNames: ["x.test"], listenPorts: ["80"] }, [{ file: "/e/x.conf", managed: false, serverNames: ["x.test"], listens: ["80"] }, { file: "/e/y.conf", managed: false, serverNames: ["y.test"], listens: ["80"] }], "shop").length, 1);
});

test("ssh: arguments enforce strict host key checking, never carry a secret, and refuse malformed input", () => {
  const c = { name: "t", host: "203.0.113.5", port: 2222, user: "deploy", auth: { kind: "key" as const, keyPath: "/k/id" }, timeoutSeconds: 7, agentDir: ".pso-agent", createdAt: "", credentialVersion: 1 };
  const a = sshBaseArgs(c, { knownHosts: "/kh" }).join(" ");
  assert.match(a, /StrictHostKeyChecking=yes/); assert.match(a, /UserKnownHostsFile=\/kh/); assert.match(a, /BatchMode=yes/); assert.match(a, /ConnectTimeout=7/); assert.match(a, /-p 2222/); assert.match(a, /-i \/k\/id/); assert.match(a, /IdentitiesOnly=yes/); assert.match(a, /ForwardAgent=no/); assert.match(a, /ClearAllForwardings=yes/);
  const pw = sshBaseArgs({ ...c, auth: { kind: "password", passwordRef: "cred_x" } }, { knownHosts: "/kh", secrets: { password: "Sup3rSecretPw" } }).join(" "); assert.ok(!pw.includes("Sup3rSecretPw")); assert.match(pw, /BatchMode=no/); assert.match(pw, /PubkeyAuthentication=no/);
  // OpenSSH's -J would not carry our strict options to the bastion, so the jump hop is a ProxyCommand with exactly the same ones
  const jx = sshBaseArgs({ ...c, jump: { host: "bastion.example", port: 22, user: "j" } }, { knownHosts: "/kh" }).join(" ");
  assert.match(jx, /ProxyCommand=ssh .*StrictHostKeyChecking=yes.*UserKnownHostsFile=\/kh.* -W %h:%p j@bastion\.example/); assert.doesNotMatch(jx, / -J /);
  assert.match(jx, /ProxyCommand=ssh .*-i \/k\/id/, "the bastion is reached with the same key, strictly");
  for (const bad of [{ host: "a;rm -rf /" }, { host: "-oProxyCommand=x" }, { user: "root; id" }, { port: 70000 }, { agentDir: "../x" }, { agentDir: "a b" }]) assert.ok(validateConnectionShape({ ...c, ...bad }), JSON.stringify(bad));
  assert.throws(() => sshBaseArgs({ ...c, host: "a b" }, { knownHosts: "/kh" }), /invalid connection/);
});

test("Windows Credential Manager: secrets round-trip through the real store (stdin, never argv), missing and removed references read as absent", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { WindowsCredentialManager } = await import("../src/credentials.ts");
  const p = new WindowsCredentialManager(); const ref = `cred_test_${Date.now()}`;
  const secret = "p@ss w0rd with 'quotes', \"double\", $dollar, `tick` and unicode \u00e7\u00e3o \u2713";
  try {
    p.set(ref, secret); assert.equal(p.get(ref), secret);
    p.set(ref, "replaced"); assert.equal(p.get(ref), "replaced", "writing again replaces the value");
    assert.equal(p.get("cred_does_not_exist_zz"), undefined);
  } finally { p.remove(ref); }
  assert.equal(p.get(ref), undefined); assert.equal(p.remove(ref), false);
  assert.throws(() => p.set("bad ref; rm", "x"), /invalid credential reference/);
});
