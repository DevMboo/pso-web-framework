import { test } from "node:test";
import assert from "node:assert/strict";
import { assessExposure, classifyBinding, classifySudoList, findingsOf, lintNginx, parseNginx } from "../src/agent/visibility.ts";

/** Operational visibility: the exact situations found on the Azure VM, pinned. */
const owners = new Map<string, { name: string; pid: number; user?: string }>();
const base = { owners, policy: { intentionallyPublicPorts: [22, 80, 443], infrastructureNetwork: "single-server" as const }, psoPorts: new Map<number, { app: string; service: string }>(), nginxDeclaredPorts: new Set<number>() };
const L = (port: number, address: string) => ({ port, address, family: address.includes(":") ? "ipv6" as const : "ipv4" as const });

test("binding classes: loopback, all interfaces, private and public addresses", () => {
  for (const [a, b] of [["127.0.0.1", "loopback"], ["::1", "loopback"], ["::ffff:127.0.0.1", "loopback"], ["0.0.0.0", "all-interfaces"], ["::", "all-interfaces"], ["10.1.2.3", "private"], ["172.16.0.4", "private"], ["172.32.0.1", "public-address"], ["192.168.1.5", "private"], ["fd00::1", "private"], ["203.0.113.9", "public-address"]] as const) assert.equal(classifyBinding(a), b, a);
});

test("RabbitMQ on all interfaces (the Azure finding) is flagged as potentially unsafe, with a remediation; the same port on loopback is fine; SSH, HTTP and HTTPS are intentionally public", () => {
  const r = assessExposure({ ...base, listeners: [L(5672, "0.0.0.0"), L(25672, "0.0.0.0"), L(4369, "0.0.0.0"), L(22, "0.0.0.0"), L(80, "0.0.0.0"), L(443, "::"), L(6379, "127.0.0.1"), L(5432, "::1")] });
  const by = (p: number) => r.find((x) => x.port === p)!;
  assert.equal(by(5672).verdict, "unexpected-all-interfaces"); assert.equal(by(5672).component, "rabbitmq"); assert.equal(by(25672).verdict, "unexpected-all-interfaces"); assert.equal(by(4369).component, "erlang-epmd");
  for (const p of [22, 80, 443]) assert.equal(by(p).verdict, "intentionally-public", String(p));
  assert.equal(by(6379).verdict, "ok"); assert.equal(by(5432).verdict, "ok");
  assert.equal(by(5672).externalReachability, "unknown", "the server cannot know it");
  const f = findingsOf(r); assert.equal(f.length, 3); assert.ok(f.every((x) => x.severity === "high")); assert.match(f[0]!.remediation.join(" "), /NODE_IP_ADDRESS=127\.0\.0\.1|epmd/);
  assert.match(f[0]!.implication, /POTENTIALLY reachable/); assert.match(f[0]!.implication, /not as publicly reachable/);
});

test("policy: a distributed environment accepts private addresses for infrastructure, a single server does not; an unknown listener on all interfaces is never silently fine", () => {
  const priv = [L(5432, "10.0.0.5"), L(6379, "10.0.0.5")];
  assert.ok(assessExposure({ ...base, listeners: priv }).every((x) => x.verdict === "unexpected-private-binding"));
  assert.ok(assessExposure({ ...base, policy: { ...base.policy, infrastructureNetwork: "distributed" }, listeners: priv }).every((x) => x.verdict === "ok"));
  assert.equal(assessExposure({ ...base, listeners: [L(9999, "0.0.0.0")] })[0]!.verdict, "unclassified-all-interfaces");
  assert.equal(assessExposure({ ...base, policy: { ...base.policy, intentionallyPublicPorts: [22, 80, 443, 9999] }, listeners: [L(9999, "0.0.0.0")] })[0]!.verdict, "intentionally-public");
  const ps = new Map([[8201, { app: "shop-customers", service: "customers" }]]);
  assert.equal(assessExposure({ ...base, psoPorts: ps, listeners: [L(8201, "0.0.0.0")] })[0]!.verdict, "unexpected-all-interfaces", "an internal PSO service must not listen on all interfaces");
  assert.equal(assessExposure({ ...base, nginxDeclaredPorts: new Set([8443]), listeners: [L(8443, "0.0.0.0")] })[0]!.verdict, "intentionally-public", "declared by a PSO-managed nginx server block");
});

test("effective sudo: the Azure default (ALL) is UNRESTRICTED, never a narrow policy; exact commands are restricted; wildcards, shells and editors are broad; nothing listable is unknown", () => {
  const azure = "Matching Defaults entries for deploy on app-server-01:\n    env_reset\n\nUser deploy may run the following commands on app-server-01:\n    (ALL : ALL) ALL\n    (ALL) NOPASSWD: /usr/sbin/nginx -t\n";
  assert.equal(classifySudoList(azure).level, "unrestricted");
  const narrow = "User deploy may run the following commands on host:\n    (root) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload\n";
  const n = classifySudoList(narrow); assert.equal(n.level, "restricted"); assert.equal(n.passwordless, true); assert.deepEqual(n.commands, ["/usr/sbin/nginx -t", "/usr/sbin/nginx -s reload"]);
  assert.equal(classifySudoList("User x may run the following commands on h:\n    (root) NOPASSWD: /usr/sbin/nginx *\n").level, "broad");
  assert.equal(classifySudoList("User x may run the following commands on h:\n    (root) NOPASSWD: /usr/bin/vim /etc/nginx/nginx.conf\n").level, "broad", "an editor can spawn a root shell");
  assert.equal(classifySudoList("User x may run the following commands on h:\n    (root) NOPASSWD: /usr/bin/systemctl restart nginx\n").level, "broad", "systemctl is on the escalation list");
  assert.equal(classifySudoList("Sorry, user x may not run sudo on h.\n").level, "none");
  assert.equal(classifySudoList("sudo: a password is required\n").level, "unknown");
  assert.equal(classifySudoList("(ALL) ALL").level, "unknown", "no listing header: refuse to guess");
});

test("nginx lint refuses anything that writes files, loads code, reaches outside the app or breaks the structure; a normal PSO-style file passes", () => {
  const ok = "# Managed by PSO Web (app=a)\n# pso-release: r1\nupstream pso_a_web {\n    server 127.0.0.1:20001;\n}\nserver {\n    listen 443 ssl;\n    server_name _;\n    ssl_certificate /etc/ssl/pso/server.pem;\n    ssl_certificate_key /etc/ssl/pso/server.key;\n    location / {\n        proxy_pass http://pso_a_web;\n        proxy_set_header Host $host;\n    }\n}\n";
  assert.deepEqual(lintNginx(ok), []);
  for (const [bad, why] of [["server { root /; }", "root"], ["server { access_log /etc/cron.d/x; }", "access_log"], ["load_module /tmp/x.so;", "load_module"], ["include /etc/passwd;", "include"], ["server { location / { alias /etc/; } }", "alias"], ["server { location / { proxy_pass http://evil.example; } }", "proxy_pass"], ["server { location / { proxy_pass http://169.254.169.254/; } }", "proxy_pass"], ["server { ssl_certificate /etc/ssl/../../shadow; }", "TLS file"], ["server { ssl_certificate /root/key.pem; }", "TLS file"], ["server { location / { content_by_lua_block { os.execute('id') } } }", "by_lua"], ["server { listen 80; ", "braces"], ["user root;", "user"]] as const)
    assert.ok(lintNginx(bad).some((p) => p.includes(why)), `${bad} -> ${why}`);
  assert.ok(lintNginx("a".repeat(70_000)).some((p) => /64 KB/.test(p)));
});

test("nginx parsing: servers, listens, TLS, locations and upstreams of a PSO-style file", () => {
  const p = parseNginx("upstream pso_x_web {\n server 127.0.0.1:20001;\n server 127.0.0.1:20002;\n}\nserver {\n listen 127.0.0.1:20000;\n server_name _;\n location / { proxy_pass http://pso_x_web; }\n}\nserver {\n listen 80;\n server_name shop.example.com;\n return 301 https://$host$request_uri;\n}\nserver {\n listen 443 ssl;\n server_name shop.example.com;\n ssl_certificate /etc/ssl/pso/server.pem;\n location /api { proxy_pass http://pso_x_web; }\n}\n");
  assert.deepEqual(p.upstreams, [{ name: "pso_x_web", servers: ["127.0.0.1:20001", "127.0.0.1:20002"] }]);
  assert.equal(p.servers.length, 3); assert.deepEqual(p.servers[0]!.listens, [{ address: "127.0.0.1", port: 20000, ssl: false }]);
  assert.deepEqual(p.servers[2]!.listens, [{ port: 443, ssl: true }]); assert.equal(p.servers[2]!.certificate, "/etc/ssl/pso/server.pem"); assert.deepEqual(p.servers[2]!.locations, [{ path: "/api", proxyPass: "http://pso_x_web" }]);
  assert.ok(p.servers[1]!.returns?.[0]?.startsWith("301"));
});

test("IPv6-mapped loopback (what a Java service listens on) is loopback, not a public address", async () => {
  const { hexV6 } = await import("../src/agent/visibility.ts");
  assert.equal(hexV6("0000000000000000FFFF00000100007F"), "::ffff:127.0.0.1"); assert.equal(classifyBinding(hexV6("0000000000000000FFFF00000100007F")), "loopback");
  assert.equal(hexV6("00000000000000000000000001000000"), "::1"); assert.equal(hexV6("00000000000000000000000000000000"), "::"); assert.equal(classifyBinding("::ffff:0.0.0.0"), "all-interfaces");
});
test("the redactor does not mask the non-secret `passwordless` field of the privilege report", async () => {
  const { redactValue } = await import("../src/redact.ts"); assert.equal((redactValue({ passwordless: true, passwordlessNote: "x", password: "p" }) as any).passwordless, true);
});
