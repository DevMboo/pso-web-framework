import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ALL_COMMANDS, MAX_ARGS } from "../src/registry.ts";
import { closest, optionsFromUsage, parseForCommand, specOf, splitCommand } from "../src/cli-spec.ts";
import { commandHelp, helpText, NOT_IMPLEMENTED } from "../src/main.ts";
import { pso, tmp } from "./helpers.ts";

/**
 * F-02: the CLI accepts exactly what each command declares. An unknown flag used to be dropped without a word, so
 * `pso make:route ... --scope reports:read` (the flag is --scopes) produced a route WITHOUT the authorization it was asked for.
 * Now every argument is checked against the command's own usage line before the command runs, and a usage error changes nothing.
 */

async function workspace(): Promise<{ base: string; root: string }> {
  const base = tmp("pso-args-");
  assert.equal((await pso(base, "create", "workspace", "w")).code, 0);
  const root = join(base, "w");
  assert.equal((await pso(root, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "service", "reports", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "make:module", "reports", "--service", "gw")).code, 0);
  assert.equal((await pso(root, "make:controller", "reports", "--service", "gw")).code, 0);
  return { base, root };
}
const snapshot = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}\n${readFileSync(p, "utf8")}`); } };
  walk(dir);
  return out.join("\n---\n");
};

test("a mistyped security flag is refused before anything is written: --scope is not --scopes", async () => {
  const { base, root } = await workspace();
  try {
    const before = snapshot(root);
    const r = await pso(root, "make:route", "reports", "findAll", "--method", "GET", "--path", "/", "--service", "gw", "--scope", "reports:read");
    assert.equal(r.code, 2, "a usage error has its own exit code");
    assert.match(r.err, /Unknown option "--scope" for `pso make:route`/);
    assert.match(r.err, /Did you mean --scopes\?/);
    assert.match(r.err, /nothing was changed/);
    assert.equal(snapshot(root), before, "no file was created or modified");
    assert.ok(!/findAll/.test(read(root, "gw/src/routes/reports/ROUTES.pso.ts")), "the route was not declared without its policy");
    // the same command with the flag spelled correctly carries the policy into the declaration
    const ok = await pso(root, "make:route", "reports", "findAll", "--method", "GET", "--path", "/", "--service", "gw", "--scopes", "reports:read");
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(read(root, "gw/src/routes/reports/ROUTES.pso.ts"), /scopes: \["reports:read"\]/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
const read = (...p: string[]): string => readFileSync(join(...p), "utf8");

test("unknown flags, extra arguments, missing values and values given to switches are usage errors", async () => {
  const { base, root } = await workspace();
  try {
    const before = snapshot(root);
    const cases: Array<[argv: string[], message: RegExp]> = [
      [["validate", "--jsno"], /Unknown option "--jsno" for `pso validate`\. Did you mean --json\?/],
      [["validate", "extra"], /Unexpected argument "extra" for `pso validate`: it takes no positional argument/],
      [["make:module", "billing", "second", "--service", "gw"], /Unexpected argument "second" for `pso make:module`: it takes at most 1 positional argument/],
      [["make:route", "reports", "list", "--method", "--path", "/", "--service", "gw"], /Option "--method" of `pso make:route` needs a value/],
      [["make:route", "reports", "list", "--method=", "--service", "gw"], /Option "--method" of `pso make:route` needs a value \(it is empty\)/],
      [["make:route", "reports", "list", "--public=yes", "--service", "gw"], /Option "--public" of `pso make:route` is a switch and takes no value/],
      [["make:route", "reports", "list", "--service"], /Option "--service" of `pso make:route` needs a value/],
      [["routes:list", "-x"], /Unknown option "-x" for `pso routes:list`: short options are not supported/],
      [["services:list", "--verbose", "--json"], /Unknown option "--verbose" for `pso services:list`/],
      [["docker:init", "--transprt", "tls"], /Unknown option "--transprt" for `pso docker:init`\. Did you mean --transport\?/],
      [["security:check", "--strct"], /Did you mean --strict\?/],
      [["tls:init", "--dev", "--day", "30"], /Unknown option "--day" for `pso tls:init`\. Did you mean --days\?/],
    ];
    for (const [argv, message] of cases) {
      const r = await pso(root, ...argv);
      assert.equal(r.code, 2, `${argv.join(" ")}: ${r.out}${r.err}`);
      assert.match(r.err, message, argv.join(" "));
      assert.match(r.err, /usage: pso /, "the usage line is shown");
    }
    assert.equal(snapshot(root), before, "none of them changed a file");
    // every problem of one invocation is reported together
    const many = await pso(root, "make:route", "reports", "list", "--scope", "a", "--guards", "jwt", "--service", "gw");
    assert.equal(many.code, 2);
    assert.match(many.err, /--scope"/); assert.match(many.err, /--guards"/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("generic generators no longer accept route and authorization flags they never used", async () => {
  const { base, root } = await workspace();
  try {
    for (const flag of [["--guard", "jwt"], ["--scopes", "a:b"], ["--public"], ["--target", "reports"], ["--route", "/x"]]) {
      const r = await pso(root, "make:middleware", "audit", "--service", "gw", ...flag);
      assert.equal(r.code, 2, `${flag[0]} must be refused: ${r.out}${r.err}`);
      assert.match(r.err, new RegExp(`Unknown option "${flag[0]}" for \`pso make:middleware\``));
    }
    assert.ok(!existsSync(join(root, "gw/src/middlewares/audit.middleware.ts")));
    assert.equal((await pso(root, "make:middleware", "audit", "--service", "gw")).code, 0);
    // the kinds whose template has a path still take it
    assert.equal((await pso(root, "make:contract", "billing", "--service", "gw", "--route", "/billing", "--method", "POST")).code, 0);
    assert.match(read(root, "gw/src/contracts/billing.contract.json"), /"path": "\/billing"/);
    // an option of the orchestrator form given to the Spring form (and the reverse) is refused instead of ignored
    const spring = await pso(root, "make:controller", "invoices", "--service", "reports", "--prefix", "/x");
    assert.equal(spring.code, 2, spring.out + spring.err);
    assert.match(spring.err, /--prefix does not apply to a Spring Boot service/);
    const node = await pso(root, "make:controller", "reports", "extra", "--service", "gw", "--route", "/x");
    assert.equal(node.code, 2, node.out + node.err);
    assert.match(node.err, /--route does not apply to the orchestrator/);
    // contradictory authorization flags are refused, not resolved silently
    const both = await pso(root, "make:route", "reports", "open", "--method", "GET", "--path", "/open", "--public", "--scopes", "a:b", "--service", "gw");
    assert.equal(both.code, 2, both.out + both.err);
    assert.match(both.err, /--public cannot be combined with --guard or --scopes/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("valid invocations keep working: --flag value, --flag=value, repeated flags, flags in any position, help", async () => {
  const { base, root } = await workspace();
  try {
    assert.equal((await pso(root, "--json", "services:list")).code, 0, "a switch before the command name");
    assert.equal((await pso(root, "services:list", "--json")).code, 0);
    assert.equal((await pso(root, "make:route", "reports", "list", "--method=GET", "--path=/list", "--service=gw", "--guard=jwt", "--scopes=reports:read,reports:list")).code, 0);
    assert.match(read(root, "gw/src/routes/reports/ROUTES.pso.ts"), /scopes: \["reports:read","reports:list"\]/);
    const shown = await pso(root, "config:show", "--service", "gw", "--set", "http.limits.maxBodyBytes=1000", "--set", "logging.level=debug", "--json");
    assert.equal(shown.code, 0, shown.out + shown.err);
    assert.match(shown.out, /1000/); assert.match(shown.out, /debug/);
    for (const argv of [["make:route", "--help"], ["make:route", "-h"], ["help", "make:route"]]) {
      const h = await pso(root, ...argv);
      assert.equal(h.code, 0);
      assert.match(h.out, /Usage: pso make:route /);
      assert.match(h.out, /--scopes <value>/, "options and whether they take a value are listed");
      assert.match(h.out, /--public\n/);
    }
    assert.equal((await pso(root, "make:route", "--help", "--no-such-flag")).code, 0, "--help never fails on the other arguments");
    const unknown = await pso(root, "make:rout");
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /Unknown command "make:rout"\. Did you mean `pso make:route`\?/);
    for (const n of NOT_IMPLEMENTED) assert.equal((await pso(root, n)).code, 2, `${n} is not implemented and says so`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the usage line is the declaration: every command has one that parses, a positional limit, and help that lists its options", () => {
  const names = Object.keys(ALL_COMMANDS).sort();
  assert.ok(names.length >= 89, `the command surface did not shrink (${names.length})`);
  for (const name of names) {
    const cmd = ALL_COMMANDS[name]!;
    assert.ok(cmd.usage.startsWith(`pso ${name}`), `${name}: the usage line starts with the command`);
    assert.ok(cmd.summary.length > 10, `${name}: has a summary`);
    assert.notEqual(MAX_ARGS[name], undefined, `${name}: declares how many positional arguments it takes (registry.ts MAX_ARGS)`);
    assert.equal(cmd.args, MAX_ARGS[name], `${name}: the positional limit is applied`);
    const spec = specOf(cmd);
    assert.ok(spec.options.has("help"));
    const help = commandHelp(name);
    for (const [flag, kind] of spec.options) if (flag !== "help") assert.ok(help.includes(`--${flag}${kind === "value" ? " <value>" : ""}`), `${name}: help lists --${flag}`);
    // every flag written in the usage line is accepted by the parser, with or without a value as written
    for (const [flag, kind] of optionsFromUsage(cmd.usage)) {
      const r = parseForCommand(name, kind === "value" ? [`--${flag}`, "x"] : [`--${flag}`], spec);
      assert.deepEqual(r.problems, [], `${name} --${flag}`);
    }
  }
  for (const name of Object.keys(MAX_ARGS)) assert.ok(ALL_COMMANDS[name], `MAX_ARGS lists "${name}", which is not a command`);
  const text = helpText();
  for (const name of names) assert.ok(text.includes(`  ${name} `) || text.includes(`  ${name.padEnd(18)}`), `pso help lists ${name}`);
});

test("option parsing rules", () => {
  assert.deepEqual([...optionsFromUsage("pso x <a> [--one] [--two v] [--three <v>] [--four \"a:b\"] [--five | --six v --seven] --eight [--nine a|b] [--ten [--eleven 1MB]]")], [
    ["one", "boolean"], ["two", "value"], ["three", "value"], ["four", "value"], ["five", "boolean"], ["six", "value"], ["seven", "boolean"], ["eight", "boolean"], ["nine", "value"], ["ten", "boolean"], ["eleven", "value"],
  ]);
  const spec = specOf({ usage: "pso x [--name v] [--flag] [--set k=v ...]", args: 1 });
  assert.deepEqual(parseForCommand("x", ["a", "--name", "v", "--flag"], spec), { positionals: ["a"], flags: { name: "v", flag: true }, problems: [] });
  assert.deepEqual(parseForCommand("x", ["--flag", "a"], spec).positionals, ["a"], "a switch never swallows the next word");
  assert.equal(parseForCommand("x", ["--set", "a=1", "--set", "b=2"], spec).flags["set"], "a=1\nb=2");
  assert.equal(parseForCommand("x", ["--name", "--flag"], spec).problems.length, 1, "a flag is not a value");
  assert.equal(parseForCommand("x", ["--name", "-1"], spec).flags["name"], "-1", "a negative number is a value");
  assert.equal(parseForCommand("x", ["a", "b"], spec).problems.length, 1);
  // the word after an unknown flag is not reinterpreted as a positional argument
  assert.deepEqual(parseForCommand("x", ["--nme", "v"], spec).positionals, []);
  assert.equal(closest("scope", ["scopes", "service"]), "scopes");
  assert.equal(closest("zzzzzz", ["scopes", "service"]), undefined);
  assert.deepEqual(splitCommand(["--json", "validate", "x"]), { command: "validate", rest: ["--json", "x"] });
  assert.deepEqual(splitCommand(["--help"]), { command: undefined, rest: ["--help"] });
});
