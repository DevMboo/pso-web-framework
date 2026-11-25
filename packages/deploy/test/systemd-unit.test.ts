import { test } from "node:test";
import assert from "node:assert/strict";
import { execWord, renderUnit, unitNameFor, type UnitSlot } from "../src/agent/systemd.ts";

/** The unit file is generated from validated fields: nothing a declaration says can add a directive, and a stopped release is not a failure. */
const slot = (over: Partial<UnitSlot> = {}): UnitSlot => ({ app: "shop-orders", service: "orders", release: "r20261115-ab12cd34", instance: 0, token: "tok123", port: 20001, cmd: ["java", "-jar", "app.jar"], cwd: "/home/u/.pso-agent/apps/shop-orders/releases/r1/src", logFile: "/home/u/.pso-agent/apps/shop-orders/logs/services/x.log", graceSeconds: 20, runDir: "/home/u/.pso-agent/apps/shop-orders/run", ...over });

test("SIGTERM exit status 143 (a JVM stopping on request) is a success, so a replaced release is not listed as failed", () => {
  const u = renderUnit(slot(), "/run/x.env", ["/usr/bin/java", "-jar", "app.jar"]); assert.match(u, /^SuccessExitStatus=143$/m); assert.match(u, /^KillSignal=SIGTERM$/m); assert.match(u, /^TimeoutStopSec=25$/m);
});
test("arguments cannot add directives, expand variables or break out of the command line", () => {
  for (const evil of ["x\nExecStartPre=/bin/sh -c 'id'", 'x"\nUser=root', "$(id)", "%n %H", "a b;c", "\n[Service]"]) {
    const u = renderUnit(slot(), "/run/x.env", ["/usr/bin/java", evil]); const lines = u.split("\n");
    assert.equal(lines.filter((l) => /^(ExecStartPre|ExecStartPost|User|Group|ExecStop|ExecReload)=/.test(l)).length, 0, JSON.stringify(evil));
    assert.equal(lines.filter((l) => /^ExecStart=/.test(l)).length, 1, JSON.stringify(evil));
  }
  assert.equal(execWord("a$b"), '"a$$b"'); assert.equal(execWord("100%"), '"100%%"'); assert.doesNotMatch(execWord("x\ny"), /\n/);
});
test("secrets never enter the unit file: only a reference to the private environment file", () => {
  const u = renderUnit(slot(), "/home/u/.pso-agent/apps/shop-orders/run/u.env", ["/usr/bin/java", "-jar", "app.jar"]);
  assert.match(u, /^EnvironmentFile=-\/home\/u\/\.pso-agent\/apps\/shop-orders\/run\/u\.env$/m); assert.doesNotMatch(u, /DB_PASSWORD|amqp:|SIGNING_KEY|BUS_SECRET/); assert.match(u, /^# Managed by PSO Web/); assert.match(u, /^NoNewPrivileges=yes$/m);
});
test("unit names have a fixed, validated shape", () => { assert.equal(unitNameFor(slot()), "pso-shop-orders-orders-r20261115-ab12cd34-0.service"); assert.match(unitNameFor(slot({ app: "A" })), /^pso-a-/, "lower-cased"); });
