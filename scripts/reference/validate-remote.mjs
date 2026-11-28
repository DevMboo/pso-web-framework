#!/usr/bin/env node
// REAL remote deployment of the reference workspace's "staging" environment to an ISOLATED Linux host reached over SSH (a disposable
// Docker-in-Docker container with sshd; never a production server). The script plays two roles:
//   operator  starts the host, authorizes a deploy key, places the operator's own certificates and secret files on the host
//   developer runs only `pso` commands: connection:add (pinned host key), host:inspect, host:check, deploy --dry-run, deploy --yes,
//             deploy:status, deploy:logs, a failing release (automatic rollback), rollback, the deployment lock
// Usage: node scripts/reference/validate-remote.mjs [--keep] [--out <evidence json>]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const root = join(repo, "fixtures", "pso-reference");
const outFlag = process.argv.indexOf("--out");
const out = outFlag > 0 ? resolve(process.argv[outFlag + 1]) : join(repo, "docs", "implementation", "evidence", "v020", "remote-deploy.json");
const { createDevCertificate } = await import(new URL("../../packages/core/dist/index.js", import.meta.url).href);
const PSO = join(repo, "packages", "cli", "bin", "pso.js");
const HOST = "pso-remote-staging-host";
const work = mkdtempSync(join(tmpdir(), "pso-remote-"));
const cloudHome = join(work, "cloud");
const results = [], transcript = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 220)})` : ""}`); };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 1_800_000, maxBuffer: 256 * 1024 * 1024, ...o });
const pso = (...a) => { const r = run(process.execPath, [PSO, ...a], { cwd: root, env: { ...process.env, PSO_CLOUD_HOME: cloudHome, MSYS_NO_PATHCONV: "1" } }); transcript.push({ command: `pso ${a.join(" ")}`, exit: r.status, output: (r.stdout + r.stderr).slice(-3000) }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const dx = (...a) => run("docker", ["exec", HOST, ...a]);

// ---------------------------------------------------------------- operator: an isolated host with sshd and Docker
run("docker", ["rm", "-f", HOST]);
const started = run("docker", ["run", "-d", "--privileged", "--name", HOST, "-p", "127.0.0.1:2222:22", "pso-e2e-dockerhost:1"]);
if (started.status !== 0) { console.error("the isolated host could not be started: " + started.stderr); process.exit(2); }
for (let i = 0; i < 60 && dx("docker", "info").status !== 0; i++) run(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
check("operator: isolated Linux host with sshd and Docker Engine is up", dx("docker", "info").status === 0);
const key = join(work, "deploy_ed25519");
run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "pso-remote-validation", "-f", key]);
dx("sh", "-c", `mkdir -p /home/pso/.ssh && printf '%s\\n' '${readFileSync(`${key}.pub`, "utf8").trim()}' > /home/pso/.ssh/authorized_keys && chown -R pso: /home/pso/.ssh && chmod 600 /home/pso/.ssh/authorized_keys`);
// the host key fingerprint, obtained out of band (as an administrator reads it on the console), then approved explicitly
const fp = dx("ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub").stdout.split(" ")[1];
// the operator's own certificate authority and certificates (never PSO's development authority) and secret files, placed on the host
const ca = createDevCertificate({ commonName: "Operator CA (staging validation)", ca: true });
const names = { edge: ["edge", "localhost", "shop.staging.pso.localhost", "admin.staging.pso.localhost", "api.staging.pso.localhost", "auth.staging.pso.localhost"], gateway: ["gateway", "localhost"], catalog: ["catalog", "localhost"], accounts: ["accounts", "localhost"], idp: ["idp", "localhost", "127.0.0.1", "auth.staging.pso.localhost"] };
const ops = join(work, "ops"); mkdirSync(join(ops, "tls"), { recursive: true }); mkdirSync(join(ops, "secrets"));
writeFileSync(join(ops, "tls", "ca.crt"), ca.certPem);
for (const [n, sans] of Object.entries(names)) { const l = createDevCertificate({ commonName: n, names: sans, issuer: ca, client: n === "accounts" }); mkdirSync(join(ops, "tls", n)); writeFileSync(join(ops, "tls", n, "tls.crt"), l.certPem); writeFileSync(join(ops, "tls", n, "tls.key"), l.keyPem); writeFileSync(join(ops, "tls", n, "ca.crt"), ca.certPem); }
const gc = createDevCertificate({ commonName: "gateway", names: ["gateway"], issuer: ca, client: true }); mkdirSync(join(ops, "tls", "gateway-client")); writeFileSync(join(ops, "tls", "gateway-client", "tls.crt"), gc.certPem); writeFileSync(join(ops, "tls", "gateway-client", "tls.key"), gc.keyPem); writeFileSync(join(ops, "tls", "gateway-client", "ca.crt"), ca.certPem);
for (const s of ["db-catalog", "idp-admin"]) writeFileSync(join(ops, "secrets", s), `${s}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);
run("docker", ["cp", ops, `${HOST}:/etc/pso-reference`]);
dx("sh", "-c", "chown -R pso: /etc/pso-reference && chmod -R go-rwx /etc/pso-reference");

// ---------------------------------------------------------------- developer: the environment is declared to deploy there
const contractFile = join(root, "pso.infra.json");
const original = readFileSync(contractFile, "utf8");
const packageJsons = ["gateway"].map((d) => join(root, d, "package.json")).map((f) => [f, readFileSync(f, "utf8")]);
const c = JSON.parse(original);
c.environments.staging = { kind: "staging", domain: "staging.pso.localhost", runtime: "docker", httpsPort: 9443, tls: { source: "external", dir: "/etc/pso-reference/tls" }, secrets: { provider: "file", dir: "/etc/pso-reference/secrets" }, dns: { provider: "external" }, deploy: { target: "ssh", connection: "staging-host", root: "/srv/pso" } };
writeFileSync(contractFile, JSON.stringify(c, null, 2) + "\n");
try {
  let r = pso("connection:add", "staging-host", "--host", "127.0.0.1", "--port", "2222", "--user", "pso", "--auth", "key", "--key", key, "--accept-host-key", fp);
  check("connection:add pins the host key and keeps only a key-file reference", r.code === 0, (r.out + r.err).trim().split("\n").pop());
  check("no secret material entered the workspace", !original.includes("BEGIN") && !JSON.stringify(c).includes(readFileSync(key, "utf8").slice(40, 80)));
  r = pso("host:inspect", "staging-host", "--json");
  const facts = JSON.parse(r.out);
  check("host:inspect detects OS, architecture, Docker, Compose, disk and ports", r.code === 0 && facts.docker && facts.compose && facts.arch && facts.diskFreeMb > 0, `${facts.os} ${facts.arch}, docker ${facts.docker}, compose ${facts.compose}, ${facts.diskFreeMb} MB free`);
  r = pso("infra:apply", "--env", "staging", "--yes");
  check("staging configuration generated (no key or secret generated for staging)", r.code === 0);
  for (const p of ["fei-shop", "fei-admin", "mei-catalog", "mei-cart", "mei-users"]) pso("frontend:publish", p, "--env", "staging");
  r = pso("host:check", "--env", "staging", "--json");
  const hc = JSON.parse(r.out);
  check("host:check verifies the operator's certificates on the host and finds the secret files (contents not read)", r.code === 0 && hc.findings.some((f) => f.check === "tls" && /verified on the host/.test(f.message)) && hc.findings.some((f) => f.check === "secrets" && /present/.test(f.message)), hc.findings.map((f) => `${f.check}:${f.severity}`).join(" "));
  // the fixtures reference the framework source (file:), so the images are built with the framework packages vendored into the services
  r = pso("docker:build", "--env", "staging", "--vendor");
  check("docker:build --env staging --vendor (framework packages copied into the services for the image build)", r.code === 0, r.out.split("\n").slice(-2).join(" | "));
  r = pso("deploy", "--env", "staging", "--dry-run");
  check("deploy --dry-run plans the remote lifecycle and changes nothing", r.code === 0 && /transfer the release/.test(r.out) && dx("test", "-e", "/srv/pso/pso-reference-staging").status !== 0);
  const t0 = Date.now();
  r = pso("deploy", "--env", "staging", "--yes", "--timeout", "420");
  const first = Date.now() - t0;
  check("deploy --yes: transferred, integrity verified, started, verified through an SSH tunnel, activated", r.code === 0 && /integrity verified on the host/.test(r.out) && /is active on staging-host and verified/.test(r.out), `${Math.round(first / 1000)} s; ${(r.out.match(/^ok .*/gm) ?? []).length} probes`);
  const rel1 = /release (\S+) of "staging" is active/.exec(r.out)?.[1];
  // the framework's edge image on the host (0.2.0-rc.8): built here, transferred like the services' images, tested by nginx on the host
  check("edge: the framework's edge image was transferred and nginx -t passed on the host before the release started", /transferring image pso-edge:[0-9a-f]{16}/.test(r.out) && /edge configuration accepted by nginx -t on the host/.test(r.out), (r.out.match(/.*(pso-edge|nginx -t).*/g) ?? []).join(" | "));
  const remoteEdge = dx("sh", "-c", "docker ps --filter label=com.docker.compose.service=edge --format '{{.Image}}'").stdout.trim();
  check("edge: the host's edge runs the framework image", /^pso-edge:[0-9a-f]{16}$/.test(remoteEdge), remoteEdge);
  const plain = dx("sh", "-c", "curl -sS -i -H 'Host: shop.staging.pso.localhost' http://127.0.0.1:$(docker port $(docker ps -q --filter label=com.docker.compose.service=edge) 8443/tcp | head -1 | cut -d: -f2)/ 2>&1 || true").stdout;
  check("edge: on the host, plain HTTP on the TLS port answers the sanitized 400 (no Server header, no nginx page)", /HTTP\/1\.1 400/.test(plain) && !/^\s*Server:/im.test(plain) && !/nginx|plain HTTP/i.test(plain.replace(/<style>[\s\S]*?<\/style>/, "")) && /Error 400/.test(plain), plain.slice(0, 300));
  check("edge: the deployment's own probes include the disclosure checks and passed", /ok\s+edge: plain HTTP on the TLS port/.test(r.out) || /edge: plain HTTP on the TLS port.*sanitized/.test(r.out), (r.out.match(/.*edge:.*/g) ?? []).join(" | "));
  const vol1 = dx("docker", "volume", "inspect", "-f", "{{.CreatedAt}}", "pso-reference-staging_catalog-db-data").stdout.trim();
  r = pso("deploy:status", "--env", "staging", "--json");
  const st = JSON.parse(r.out);
  check("deploy:status reads the active release and the containers' health from the host", st.current === rel1 && st.containers.length >= 8 && st.containers.every((x) => x.state === "running"), `${st.containers.length} containers, active ${st.current}`);
  r = pso("deploy:logs", "gateway", "--env", "staging", "--tail", "20");
  check("deploy:logs reads a container log from the host", r.code === 0 && /orchestrator|upstream/.test(r.out));
  const t1 = Date.now();
  r = pso("deploy", "--env", "staging", "--yes");
  check("a second deployment transfers no image the host already has", r.code === 0 && /images transferred: none/.test(r.out), `${Math.round((Date.now() - t1) / 1000)} s`);
  const rel2 = /release (\S+) of "staging" is active/.exec(r.out)?.[1];
  // an edge configuration nginx rejects (a hand edit of the generated file, used as it is): the release is refused on the host before anything
  // starts, and the active release keeps running
  {
    const edgeConf = join(root, ".infra", "nginx", "staging", "edge.conf");
    const goodConf = readFileSync(edgeConf, "utf8");
    writeFileSync(edgeConf, goodConf + "\nbogus_directive on;\n");
    const before = JSON.parse(pso("deploy:status", "--env", "staging", "--json").out);
    const rr = pso("deploy", "--env", "staging", "--yes");
    const after = JSON.parse(pso("deploy:status", "--env", "staging", "--json").out);
    writeFileSync(edgeConf, goodConf);
    check("edge: a hand-edited edge configuration is refused before anything reaches the host (drift guard); the active release keeps running", rr.code !== 0 && /edited by hand/.test(rr.out + rr.err) && after.current === before.current && after.containers.every((x) => x.state === "running"), (rr.err || rr.out).split("\n").slice(0, 2).join(" | "));
  }
  // a release that cannot become healthy: accounts limited to 24 MB of memory
  const bad = JSON.parse(readFileSync(contractFile, "utf8")); bad.services.accounts.resources = { memory: "24m" }; writeFileSync(contractFile, JSON.stringify(bad, null, 2) + "\n");
  r = pso("deploy", "--env", "staging", "--yes", "--timeout", "150");
  check("a failing release is rolled back automatically to the previous one", r.code === 1 && /was started again/.test(r.err), (r.err.split("\n")[0] ?? ""));
  c.services.accounts.resources = undefined; writeFileSync(contractFile, JSON.stringify(c, null, 2) + "\n");
  r = pso("deploy:status", "--env", "staging", "--json");
  const st2 = JSON.parse(r.out);
  check("after the automatic rollback the previous release is active and healthy", st2.current === rel2 && st2.containers.every((x) => x.state === "running"), st2.current);
  check("the database volume survived every release and rollback", dx("docker", "volume", "inspect", "-f", "{{.CreatedAt}}", "pso-reference-staging_catalog-db-data").stdout.trim() === vol1, vol1);
  r = pso("rollback", "--env", "staging", "--to", rel1, "--yes");
  const st3 = JSON.parse(pso("deploy:status", "--env", "staging", "--json").out);
  check("rollback --env starts an earlier release on the host", r.code === 0 && st3.current === rel1, st3.current);
  run("docker", ["exec", "-u", "pso", HOST, "sh", "-c", "mkdir -p /srv/pso/pso-reference-staging/.deploy-lock && echo 'someone@elsewhere 2026' > /srv/pso/pso-reference-staging/.deploy-lock/owner"]);
  r = pso("deploy", "--env", "staging", "--yes");
  check("a concurrent deployment of the same environment is refused", r.code === 1 && /another deployment of "staging" is running/.test(r.err));
  r = pso("deploy:unlock", "--env", "staging", "--yes");
  check("deploy:unlock removes a stale lock explicitly", r.code === 0 && dx("test", "-d", "/srv/pso/pso-reference-staging/.deploy-lock").status !== 0);
  const keyTravel = dx("sh", "-c", "grep -rl 'PRIVATE KEY' /srv/pso 2>/dev/null | head -1").stdout.trim();
  check("no private key was transferred into the release directories", keyTravel === "", keyTravel);
} catch (e) { check("scenario completed without an exception", false, e.message); }
finally {
  writeFileSync(contractFile, original);
  // `docker:build --vendor` points the Node services at vendored tarballs: the committed fixture keeps its file: references
  for (const [f, text] of packageJsons) writeFileSync(f, text);
  if (!process.argv.includes("--keep")) run("docker", ["rm", "-f", HOST]);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), host: "isolated docker-in-docker container (pso-e2e-dockerhost:1) over SSH on 127.0.0.1:2222", results, transcript }, null, 2) + "\n");
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
