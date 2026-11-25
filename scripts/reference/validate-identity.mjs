#!/usr/bin/env node
// Keycloak reconciliation against the RUNNING reference stack: drift made through the real administration API (as a console user would),
// detection, refusal without authorization, correction with it, an unmanaged client left alone, users and credentials preserved, no
// Keycloak restart. Usage: node scripts/reference/validate-identity.mjs [workspace] [evidence.json]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const root = resolve(process.argv[2] ?? join(repo, "fixtures", "pso-reference"));
const out = resolve(process.argv[3] ?? join(repo, "docs", "implementation", "evidence", "v020", "identity-reconciliation.json"));
const I = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const PSO = join(repo, "packages", "cli", "bin", "pso.js");
const t = I.plan(root, "local", { frontends: I.readFrontends }).topology;
const ca = I.environmentCa(root, t), map = I.localResolution(t), base = new URL(t.identity.issuer).origin;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const pso = (...a) => { const r = spawnSync(process.execPath, [PSO, ...a], { cwd: root, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const startedAt = () => spawnSync("docker", ["inspect", "-f", "{{.State.StartedAt}}", `${t.project}-idp-1`], { encoding: "utf8" }).stdout.trim();
const req = (method, path, token, body) => { const b = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); return I.netRequest({ url: `${base}${path}`, method, ca, resolve: map, timeoutMs: 20000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(b ? { "content-type": typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json", "content-length": String(b.length) } : {}) }, ...(b ? { body: b } : {}) }); };
const adminPw = I.lookupSecret(root, "local", "local", "idp-admin").value;
const adminToken = async () => JSON.parse((await req("POST", "/realms/master/protocol/openid-connect/token", undefined, new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: adminPw }).toString())).body).access_token;
const realm = t.identity.realm;

const before = startedAt();
check("the realm starts in sync with the declarations", JSON.parse(pso("infra:identity", "--json").out).inSync === true);
const anaBefore = await I.developmentUserToken(root, t, "ana");
let tok = await adminToken();
// drift made by hand in the console: an extra redirect URI on a managed client, and a client nobody declared
const admin = (JSON.parse((await req("GET", `/admin/realms/${realm}/clients?clientId=fei-admin`, tok)).body))[0];
await req("PUT", `/admin/realms/${realm}/clients/${admin.id}`, tok, { ...admin, redirectUris: [...admin.redirectUris, "https://evil.example/*"] });
await req("POST", `/admin/realms/${realm}/clients`, tok, { clientId: "external-app", enabled: true, publicClient: true, redirectUris: ["https://external.example/*"] });
const p = JSON.parse(pso("infra:identity", "--json").out);
const upd = p.changes.find((c) => c.kind === "update-client" && c.target === "fei-admin");
check("the hand-made redirect URI on a managed client is detected as a sensitive change", upd?.sensitive === true && /evil\.example/.test(upd.detail), upd?.detail ?? "");
check("a client PSO did not create is not part of the plan", !p.changes.some((c) => c.target === "external-app"));
const noYes = pso("infra:identity", "--apply");
tok = await adminToken();
const still = (JSON.parse((await req("GET", `/admin/realms/${realm}/clients?clientId=fei-admin`, tok)).body))[0];
check("without --yes the sensitive change is not applied (exit 3)", noYes.code === 3 && still.redirectUris.includes("https://evil.example/*"), `exit ${noYes.code}`);
const yes = pso("infra:identity", "--apply", "--yes");
tok = await adminToken();
const fixed = (JSON.parse((await req("GET", `/admin/realms/${realm}/clients?clientId=fei-admin`, tok)).body))[0];
check("with --yes the managed client is restored to the declarations", yes.code === 0 && !fixed.redirectUris.includes("https://evil.example/*") && fixed.attributes["pso.managed"] === "true", fixed.redirectUris.join(", "));
const ext = (JSON.parse((await req("GET", `/admin/realms/${realm}/clients?clientId=external-app`, tok)).body))[0];
check("the unmanaged client is untouched", ext && ext.redirectUris.join() === "https://external.example/*");
const anaAfter = await I.developmentUserToken(root, t, "ana");
const sub = (x) => JSON.parse(Buffer.from(x.split(".")[1], "base64url").toString()).sub;
check("users and their credentials are preserved (same user id, password still valid)", sub(anaAfter.accessToken) === sub(anaBefore.accessToken));
check("the confidential client's secret was not reset (a token from it still works)", !!anaAfter.accessToken);
check("Keycloak was not restarted", startedAt() === before, before);
check("back in sync", JSON.parse(pso("infra:identity", "--json").out).inSync === true);
await req("DELETE", `/admin/realms/${realm}/clients/${ext.id}`, tok); // cleanup of the test's own external client
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), realm, results }, null, 2) + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
