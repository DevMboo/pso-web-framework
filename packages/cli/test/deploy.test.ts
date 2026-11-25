import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const json = async (cwd: string, ...a: string[]) => { const r = await pso(cwd, ...a, "--json"); return { code: r.code, out: r.out ? JSON.parse(r.out) : null, err: r.err }; };

test("deploy:init + deploy:validate: four targets, hardened defaults, and every policy violation is caught", { timeout: 120_000 }, async () => {
  const base = tmp("pso-deploy-"); dirs.push(base);
  mkdirSync(base, { recursive: true });
  assert.equal((await pso(base, "init")).code, 0);
  assert.equal((await pso(base, "create", "orchestrator", "gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(base, "create", "service", "orders", "--structure", "legacy", "--runtime", "spring-boot")).code, 0);

  assert.equal((await pso(base, "deploy:init")).code, 1, "a target is required");
  assert.equal((await pso(base, "deploy:init", "--target", "heroku")).code, 1);
  assert.equal((await pso(base, "deploy:init", "--target", "kubernetes", "--tag", "latest")).code, 1, "mutable tags are refused");
  assert.equal((await pso(base, "deploy:validate")).code, 1, "nothing generated yet");

  for (const t of ["kubernetes", "ecs", "container-apps", "cloud-run"]) {
    const r = await json(base, "deploy:init", "--target", t, "--registry", "registry.example.com/pso", "--tag", "1.2.3");
    assert.equal(r.code, 0, `${t}: ${r.err}`);
  }
  assert.equal((await pso(base, "deploy:init", "--target", "kubernetes", "--registry", "other.example.com", "--tag", "1.2.3")).code, 1, "an edited/different file is a conflict, never silently overwritten");

  const v = await json(base, "deploy:validate");
  assert.equal(v.code, 0, JSON.stringify(v.out?.errors));
  assert.equal(v.out.errors.length, 0);
  assert.ok(v.out.warnings.every((w: { rule: string }) => w.rule === "placeholder"), "only unfilled placeholders remain");
  assert.match(v.out.note, /no cloud account was contacted/);
  assert.equal((await pso(base, "deploy:validate", "--strict")).code, 1, "--strict fails while CHANGE_ME values remain");

  // generated content: hardened, secrets only referenced, orchestrator is the single public entry
  const k8s = readFileSync(join(base, "deploy", "kubernetes", "orders.yaml"), "utf8");
  for (const s of ["runAsNonRoot: true", "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false", "drop: [ALL]", "RuntimeDefault", "automountServiceAccountToken: false", "image: registry.example.com/pso/orders:1.2.3", "kind: NetworkPolicy", "/actuator/health"]) assert.ok(k8s.includes(s), `kubernetes: ${s}`);
  assert.match(readFileSync(join(base, "deploy", "kubernetes", "namespace.yaml"), "utf8"), /pod-security\.kubernetes\.io\/enforce: restricted/);
  const gw = readFileSync(join(base, "deploy", "kubernetes", "gateway.yaml"), "utf8");
  assert.match(gw, /PSO_UPSTREAM_ORDERS/); assert.match(gw, /\/health\/ready/);
  const task = JSON.parse(readFileSync(join(base, "deploy", "ecs", "orders.taskdef.json"), "utf8"));
  assert.equal(task.containerDefinitions[0].readonlyRootFilesystem, true); assert.equal(task.containerDefinitions[0].user, "10001");
  assert.ok(task.containerDefinitions[0].secrets.every((s: { valueFrom: string }) => s.valueFrom.startsWith("arn:aws:secretsmanager")));
  assert.match(readFileSync(join(base, "deploy", "container-apps", "orders.yaml"), "utf8"), /external: false/);
  assert.match(readFileSync(join(base, "deploy", "container-apps", "gateway.yaml"), "utf8"), /external: true/);
  assert.match(readFileSync(join(base, "deploy", "cloud-run", "orders.service.yaml"), "utf8"), /ingress: internal/);

  // violations
  const edit = (rel: string, f: (s: string) => string) => { const p = join(base, "deploy", ...rel.split("/")); writeFileSync(p, f(readFileSync(p, "utf8"))); return p; };
  const rules = async (): Promise<string[]> => ((await json(base, "deploy:validate")).out.errors as Array<{ rule: string }>).map((e) => e.rule);
  const undo = (p: string, original: string) => writeFileSync(p, original);
  const cases: Array<[string, string, (s: string) => string, string]> = [
    ["kubernetes/orders.yaml", "image-tag", (s) => s.replace("orders:1.2.3", "orders:latest"), "image-tag"],
    ["kubernetes/orders.yaml", "read-only-rootfs", (s) => s.replace("readOnlyRootFilesystem: true", "readOnlyRootFilesystem: false"), "read-only-rootfs"],
    ["kubernetes/orders.yaml", "run-as-non-root", (s) => s.replace("runAsNonRoot: true", "runAsNonRoot: false"), "run-as-non-root"],
    ["kubernetes/orders.yaml", "host-access", (s) => s.replace("      containers:", "      hostNetwork: true\n      containers:"), "host-access"],
    ["kubernetes/orders.yaml", "resource-limits", (s) => s.replace(/limits:.*\n/, "\n"), "resource-limits"],
    ["kubernetes/orders.yaml", "inline-secret", (s) => s + "# password: hunter2hunter2hunter2\n", "inline-secret"],
    ["ecs/orders.taskdef.json", "run-as-non-root", (s) => s.replace('"user": "10001"', '"user": "root"'), "run-as-non-root"],
    ["ecs/orders.taskdef.json", "inline-secret", (s) => s.replace('"environment": [', '"environment": [{"name":"DB_PASSWORD","value":"x"},'), "inline-secret"],
    ["container-apps/gateway.yaml", "tls", (s) => s.replace("allowInsecure: false", "allowInsecure: true"), "tls"],
    ["cloud-run/orders.service.yaml", "probes", (s) => s.replace(/startupProbe:|livenessProbe:/g, "x:"), "probes"],
  ];
  for (const [rel, , mutate, rule] of cases) {
    const p = join(base, "deploy", ...rel.split("/")), original = readFileSync(p, "utf8");
    edit(rel, mutate);
    const found = await rules();
    undo(p, original);
    assert.ok(found.includes(rule), `${rel}: expected rule ${rule}, got ${found.join(",") || "none"}`);
  }
  assert.equal((await pso(base, "deploy:validate")).code, 0, "restored files validate again");
});

test("create service --port: explicit, validated and unique within the workspace", async () => {
  const base = tmp("pso-port-"); dirs.push(base);
  assert.equal((await pso(base, "init")).code, 0);
  const ok = await pso(base, "create", "service", "a", "--structure", "legacy", "--port", "45123");
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(readFileSync(join(base, "pso.workspace.json"), "utf8")).services[0].port, 45123);
  assert.equal((await pso(base, "create", "service", "b", "--structure", "legacy", "--port", "45123")).code, 1, "already used in this workspace");
  for (const bad of ["80", "70000", "abc", "8081x"]) assert.equal((await pso(base, "create", "service", "c", "--structure", "legacy", "--port", bad)).code, 1, bad);
  assert.equal(JSON.parse(readFileSync(join(base, "pso.workspace.json"), "utf8")).services.length, 1);
});
