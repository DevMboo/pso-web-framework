import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import WebSocket from "ws";
import { psoJavaInstalled, psoJavaVersion } from "../src/specs.ts";
import { pso, tmp, prepare, startNode, randomPort } from "./helpers.ts";

const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const skipJava = !javaOk ? "JDK not found" : !psoJavaInstalled(psoJavaVersion()) ? "PSO Java artifacts are not installed: run `pso java:install` first" : false;
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

async function workspace() {
  const base = tmp("pso-ch-cli-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "create", "service", "recruitment-service", "--structure", "legacy");
  const run = async (...a: string[]) => { const r = await pso(root, ...a); assert.equal(r.code, 0, `${a.join(" ")}\n${r.out}${r.err}`); return r; };
  return { root, gw: join(root, "gw"), svc: join(root, "recruitment-service"), run };
}

test("channels:enable on the orchestrator: refused without Dispatch (nothing written, dry run too); with Dispatch it compiles, starts and is idempotent", { timeout: 400_000 }, async () => {
  const { root, gw, run } = await workspace();
  const { readdirSync, statSync } = await import("node:fs");
  const snap = (d: string): string => readdirSync(d).sort().map((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "node_modules" ? "" : `${n}/[${snap(p)}]`) : `${n}:${readFileSync(p).length}:${readFileSync(p, "utf8").length}`; }).join(",");
  const before = snap(gw);
  for (const extra of [[], ["--dry-run"]]) {
    const r = await pso(root, "channels:enable", "--service", "gw", ...extra);
    assert.equal(r.code, 1, `refused ${extra.join(" ")}`);
    assert.match(r.out + r.err, /no Dispatch provider[\s\S]*Nothing was changed[\s\S]*pso dispatch:install <redis\|rabbitmq\|kafka> --service gw/);
  }
  assert.equal(snap(gw), before, "no file of the orchestrator was touched");
  assert.ok(!existsSync(join(gw, "src/dispatch/channels")));
  await run("dispatch:install", "redis", "--service", "gw");
  const o = await run("channels:enable", "--service", "gw");
  assert.match(o.out, /package\.json: \+ @pso\/channels/);
  const pkg = JSON.parse(read(gw, "package.json")).dependencies;
  assert.ok(pkg["@pso/dispatch"] && pkg["@pso/channels"], "both packages the generated code imports are declared");
  const again = await run("channels:enable", "--service", "gw");
  assert.match(again.out, /already connected/, "a repeated run changes nothing");
  const afterSecond = snap(gw);
  await run("channels:enable", "--service", "gw");
  assert.equal(snap(gw), afterSecond, "idempotent");
  await run("make:module", "live", "--service", "gw");
  await run("make:channel", "live", "news", "--service", "gw", "--pattern", "news");
  assert.equal((await pso(root, "validate")).code, 0);
  prepare(gw); // real tsc: the consumer, its event declaration and the channel compile
  const keys = await generateKeyPair("ES256", { extractable: true });
  const pub = join(root, "p.pem"); writeFileSync(pub, await exportSPKI(keys.publicKey));
  const port = randomPort();
  const { child } = await startNode(gw, { PORT: String(port), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256" });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/channels`, "pso.channels.v1");
    const first = await new Promise<string>((res) => { ws.on("message", (m) => res(String(m))); ws.on("error", (e) => res(`error ${e.message}`)); setTimeout(() => res("timeout"), 10_000); });
    assert.match(first, /"t":"ready"/, "the orchestrator starts with Dispatch installed (still disabled) and serves Channels");
    ws.close();
  } finally { child.kill(); }
});

test("make:channel: class, deny-by-default access provider, event contract and registration; the result compiles and the orchestrator starts with it", { timeout: 400_000 }, async () => {
  const { root, gw, run } = await workspace();
  await run("make:module", "recruitment", "--service", "gw");
  await run("make:controller", "recruitment", "--service", "gw", "--prefix", "/recruitment");
  assert.equal((await pso(root, "make:channel", "recruitment", "bad", "--service", "gw", "--pattern", "Bad Pattern")).code, 1);
  assert.equal((await pso(root, "make:channel", "recruitment", "bad", "--service", "gw", "--visibility", "secret")).code, 1);
  assert.equal((await pso(root, "make:channel", "recruitment", "bad", "--service", "gw", "--visibility", "internal")).code, 1, "an internal channel needs declared publishers");
  assert.equal((await pso(root, "make:channel", "nomodule", "bad", "--service", "gw")).code, 1);
  await run("make:channel", "recruitment", "updates", "--service", "gw", "--pattern", "recruitment", "--scopes", "recruitment:read");
  await run("make:channel", "recruitment", "candidate", "--service", "gw", "--pattern", "candidate.{candidateId}", "--publisher", "recruitment-service", "--event", "candidate.updated", "--fields", "candidateId:string,status:enum=APPLIED|HIRED");
  const dry = await pso(root, "make:channel", "recruitment", "dry", "--service", "gw", "--dry-run");
  assert.equal(dry.code, 0); assert.ok(!existsSync(join(gw, "src/routes/recruitment/dry.channel.ts")));
  assert.equal((await pso(root, "make:channel", "recruitment", "updates", "--service", "gw")).code, 1, "an existing channel is never overwritten");
  const ch = read(gw, "src/routes/recruitment/candidate.channel.ts");
  assert.match(ch, /@Channel\("candidate\.\{candidateId\}", \{ visibility: "private", publishers: \["recruitment-service"\], events: \{ "candidate\.updated": CandidateEventDto \} \}\)/);
  assert.match(ch, /@ChannelParam\("candidateId"\) candidateId: string, @Context\(\) context: ChannelContext/);
  assert.match(ch, /this\.access\.canSubscribe\(context\.user, \{ candidateId \}\)/);
  assert.match(read(gw, "src/routes/recruitment/candidate-access.ts"), /return user !== null && false;/, "a resource channel starts CLOSED");
  const mod = read(gw, "src/routes/recruitment/MODULE.pso.ts");
  assert.match(mod, /channels: \[UpdatesChannel, CandidateChannel\]/);
  assert.match(mod, /providers: \[CandidateAccess\]/);
  assert.ok(JSON.parse(read(gw, "package.json")).dependencies["@pso/channels"]);
  const v = await run("channels:validate", "--service", "gw");
  assert.match(v.out, /2 active channel\(s\)[\s\S]*candidate\.\{candidateId\}[\s\S]*OK/);
  assert.equal((await pso(root, "validate")).code, 0);
  prepare(gw); // real tsc with decorators and metadata
  // the orchestrator starts with the generated channels, and the closed resource channel refuses everybody
  const keys = await generateKeyPair("ES256", { extractable: true });
  const pub = join(root, "p.pem"); writeFileSync(pub, await exportSPKI(keys.publicKey));
  const port = randomPort();
  const { child } = await startNode(gw, { PORT: String(port), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256" });
  try {
    const tk = await new SignJWT({ scope: "recruitment:read" }).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject("alice").setExpirationTime("10m").sign(keys.privateKey);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/channels`, "pso.channels.v1", { headers: { authorization: `Bearer ${tk}` } });
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
    ws.send(JSON.stringify({ v: 1, t: "subscribe", id: "a", channel: "recruitment" }));
    ws.send(JSON.stringify({ v: 1, t: "subscribe", id: "b", channel: "candidate.c1" }));
    for (let i = 0; i < 80 && frames.filter((f) => f["id"]).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(frames.find((f) => f["id"] === "a")!["t"], "ack", "the generated authenticated channel with its scope works");
    assert.equal(frames.find((f) => f["id"] === "b")!["code"], "PSO_CHANNEL_FORBIDDEN", "the generated resource channel denies until the rule is written");
    ws.close();
  } finally { child.kill(); }
});

test("channels:validate reports unregistered, duplicate, ambiguous and unknown channel declarations without running anything", { timeout: 200_000 }, async () => {
  const { root, gw, run } = await workspace();
  await run("make:module", "recruitment", "--service", "gw");
  await run("make:channel", "recruitment", "a", "--service", "gw", "--pattern", "zone.{id}", "--publisher", "x-service");
  const ctl = join(gw, "src/routes/recruitment");
  writeFileSync(join(ctl, "b.channel.ts"), 'import { Channel } from "@pso/channels";\n\n@Channel("zone.north")\nexport class BChannel {}\n\n@Channel("zone.{id}")\nexport class CChannel {}\n');
  let v = await pso(root, "channels:validate", "--service", "gw");
  assert.equal(v.code, 0, "decorated but unregistered classes are inactive: a warning, not an error");
  assert.match(v.out, /BChannel[^\n]*not listed in channels[^\n]*INACTIVE/);
  const mod = join(ctl, "MODULE.pso.ts");
  writeFileSync(mod, read(mod).replace("channels: [AChannel]", "channels: [AChannel, BChannel, CChannel, GhostChannel]").replace('import { AChannel }', 'import { BChannel, CChannel } from "./b.channel";\nimport { AChannel }'));
  v = await pso(root, "channels:validate", "--service", "gw");
  assert.equal(v.code, 1);
  assert.match(v.out, /duplicate channel "zone\.\{id\}"/);
  assert.match(v.out, /ambiguous channels "zone\.\{id\}"[^\n]*"zone\.north"|ambiguous channels "zone\.north"[^\n]*"zone\.\{id\}"/);
  assert.match(v.out, /GhostChannel is listed in channels[^\n]*not a @Channel class/);
});

test("layered service: make:notifier writes the record to application/event/ and the notifier to application/service/; validate and compile", { skip: skipJava, timeout: 900_000 }, async () => {
  const base = tmp("pso-ch-layered-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  const run = async (...a: string[]) => { const r = await pso(root, ...a); assert.equal(r.code, 0, `${a.join(" ")}\n${r.out}${r.err}`); return r; };
  await run("create", "service", "recruitment", "--template", "empty");
  await run("channels:enable", "--service", "recruitment");
  const made = await run("make:notifier", "candidate", "--service", "recruitment", "--channel", "candidate.{candidateId}", "--event", "candidate.updated", "--fields", "candidateId:string,status:string", "--durable");
  assert.match(made.out, /created\s+recruitment\/src\/main\/java\/com\/pso\/recruitment\/application\/event\/CandidateEvent\.java/);
  assert.match(made.out, /created\s+recruitment\/src\/main\/java\/com\/pso\/recruitment\/application\/service\/CandidateNotifier\.java/);
  const svc = join(root, "recruitment"), java = join(svc, "src/main/java/com/pso/recruitment");
  assert.match(read(java, "application/event/CandidateEvent.java").replaceAll("\r\n", "\n"), /^package com\.pso\.recruitment\.application\.event;\n[\s\S]*record CandidateEvent\(String candidateId, String status\)/);
  const n = read(java, "application/service/CandidateNotifier.java").replaceAll("\r\n", "\n");
  assert.match(n, /^package com\.pso\.recruitment\.application\.service;\n\nimport com\.pso\.recruitment\.application\.event\.CandidateEvent;/);
  assert.ok(!existsSync(join(java, "events")), "no 0.1 events/ package in a layered service");
  const vv = await pso(root, "validate");
  assert.equal(vv.code, 0, vv.out + vv.err);
  const mvn = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", "-o", "-q", "compile"]] as const : ["./mvnw", ["-B", "-ntp", "-o", "-q", "compile"]] as const;
  const r = spawnSync(mvn[0], [...mvn[1]], { cwd: svc, encoding: "utf8", timeout: 800_000 });
  assert.equal(r.status, 0, (r.stdout + r.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 20).join("\n"));
});

test("channels:enable connects the orchestrator and a Spring service to Channels; make:notifier writes a typed publisher that compiles and passes the service tests", { skip: skipJava, timeout: 900_000 }, async () => {
  const { root, gw, svc, run } = await workspace();
  await run("dispatch:install", "redis", "--service", "gw");
  const o = await run("channels:enable", "--service", "gw");
  assert.match(o.out, /@pso\/channels[\s\S]*src\/dispatch\/channels/);
  assert.match(read(gw, "src/dispatch/channels/channels.consumer.ts"), /@DispatchConsumer\("channels\.publish", \{ group: "orchestrator-channels" \}\)\nexport class ChannelEvents extends ChannelDispatchConsumer/);
  assert.match(read(gw, "src/dispatch/channels/EVENTS.pso.ts"), /consumers: \[ChannelEvents\]/);
  assert.match((await run("channels:enable", "--service", "gw")).out, /already connected/);
  const pre = await pso(root, "make:notifier", "candidate", "--service", "recruitment-service", "--channel", "candidate.{candidateId}", "--event", "candidate.updated");
  assert.equal(pre.code, 1); assert.match(pre.out + pre.err, /channels:enable/);
  await run("channels:enable", "--service", "recruitment-service");
  assert.match(read(svc, "src/main/resources/application.yml"), /channels:[^\n]*\n    enabled: true/);
  assert.equal(JSON.parse(read(svc, "src/main/resources/dispatch/channels.events.json")).events[0].name, "channels.publish");
  for (const bad of [["--channel", "Bad Channel", "--event", "a.b"], ["--channel", "x", "--event", "Bad"], ["--channel", "candidate.{candidateId}", "--event", "candidate.updated", "--fields", "status:string"], ["--channel", "x", "--event", "a.b", "--fields", "n:object"]]) assert.equal((await pso(root, "make:notifier", "candidate", "--service", "recruitment-service", ...bad)).code, 1, bad.join(" "));
  await run("make:notifier", "candidate", "--service", "recruitment-service", "--channel", "candidate.{candidateId}", "--event", "candidate.updated", "--fields", "candidateId:string,status:string", "--durable");
  const n = read(svc, "src/main/java/com/pso/recruitmentservice/application/CandidateNotifier.java");
  assert.match(n, /publisher\.publish\("candidate\." \+ event\.candidateId\(\), "candidate\.updated", event, PsoChannelPublisher\.Options\.durable\(\)\)/);
  assert.match(read(svc, "src/main/java/com/pso/recruitmentservice/events/CandidateEvent.java"), /record CandidateEvent\(String candidateId, String status\)/);
  const vv = await pso(root, "validate");
  assert.equal(vv.code, 0, vv.out + vv.err);
  const mvn = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", "test"]] as const : ["./mvnw", ["-B", "-ntp", "test"]] as const;
  const r = spawnSync(mvn[0], [...mvn[1]], { cwd: svc, encoding: "utf8", timeout: 800_000 });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 20).join("\n"));
  assert.match(out, /Tests run: \d+, Failures: 0, Errors: 0/);
});
