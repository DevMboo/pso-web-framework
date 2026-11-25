import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { classify, codeBlock, fileTree } from "../src/portal/render.ts";
import { pso, prepare, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const docs = resolve(import.meta.dirname, "..", "docs");
const example = join(docs, "examples", "spring-crud");
const page = (id: string) => readFileSync(join(docs, id + ".md"), "utf8").replaceAll("\r\n", "\n");

const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });

// ---------------------------------------------------------------- presentation components

test("block kinds: commands, program output, HTTP exchanges, diagrams and source are told apart", () => {
  assert.equal(classify("bash", "pso validate"), "command");
  assert.equal(classify("powershell", "pso validate"), "command");
  assert.equal(classify("text", "created    pom.xml"), "output");
  assert.equal(classify("text", "HTTP/1.1 401\nWWW-Authenticate: Bearer"), "http-response");
  assert.equal(classify("text", "POST /products HTTP/1.1"), "http-request");
  assert.equal(classify("http", "HTTP/1.1 200 OK"), "http-response");
  assert.equal(classify("diagram", "a --> b"), "diagram");
  assert.equal(classify("java", "class A {}"), "source");
  const cmd = codeBlock("pso create service catalog \\\n  --db postgres\n# a comment\npso validate", "bash");
  assert.match(cmd, /k-command/);
  assert.equal((cmd.match(/line cmd/g) ?? []).length, 2, "a prompt only before each command, not on continuation lines or comments");
  assert.match(cmd, /Terminal · Shell/);
  const out = codeBlock("created    pom.xml\n$ not a command", "text");
  assert.match(out, /k-output/);
  assert.doesNotMatch(out, /line cmd/);
  assert.match(out, /program output, not a command/);
  assert.doesNotMatch(out, /hljs-/, "program output is never syntax-highlighted as code");
  assert.match(codeBlock("HTTP/1.1 200 OK\ncontent-type: application/json\n\n{}", "text"), /HTTP response/);
  assert.match(codeBlock("x", "text evidence=\"verified\""), /ev-verified">Verified output</);
  assert.match(codeBlock("GET /a HTTP/1.1", "http"), /HTTP request/);
});

test("code tokens: annotations, keywords, strings, types and comments get their own classes", () => {
  const java = codeBlock("@Entity\npublic class A { // note\n  private String s = \"x\"; }", "java");
  for (const c of ["hljs-meta", "hljs-keyword", "hljs-string", "hljs-comment", "hljs-type|hljs-title class_"]) assert.match(java, new RegExp(c), c);
  for (const lang of ["typescript", "javascript", "java", "sql", "json", "yaml", "xml", "bash", "powershell", "dockerfile", "http", "ini", "env", "pom", "mjs"]) {
    assert.doesNotMatch(codeBlock("x", lang), /language-text/, `${lang} is highlighted`);
  }
  const css = readFileSync(resolve(import.meta.dirname, "..", "portal", "assets", "portal.css"), "utf8");
  assert.match(css, /\.hljs-meta \{ color: var\(--tok-annot\); \}/, "annotations are no longer styled as comments");
  assert.match(css, /--tok-annot:[^;]+;[\s\S]*--tok-annot:/, "annotation colour defined for dark and light themes");
});

test("file tree: hierarchy, folders, file kinds, origin badges and accessible labels", () => {
  const html = fileTree("shop/\n  pom.xml  # generated: build\n  src/\n    A.java  # manual\n    V2__x.sql  # optional: db\n    .env.local  # env\n    run.sh\n    Dockerfile\n    app.yml\n    x.ts\n    c.json\n    r.md\n    unknown.bin", "My tree");
  assert.match(html, /<figure class="filetree">/);
  assert.match(html, /role="tree" aria-label="My tree"/);
  assert.equal((html.match(/role="treeitem"/g) ?? []).length, 13);
  assert.match(html, /<ul role="group">/);
  for (const k of ["ft-dir", "ft-xml", "ft-java", "ft-sql", "ft-env", "ft-sh", "ft-docker", "ft-yaml", "ft-ts", "ft-json", "ft-md", "ft-other"]) assert.match(html, new RegExp(k), k);
  for (const b of ["o-generated", "o-manual", "o-optional", "o-env"]) assert.match(html, new RegExp(b), b);
  assert.match(html, /visually-hidden">Java file /, "the kind is also available as text, not only as colour");
  assert.match(html, />JV</, "a text badge, not only a colour");
  assert.match(html, /ft-note">build</);
  const nested = html.indexOf("A.java");
  assert.ok(nested > html.indexOf("src/") && html.indexOf("src/") > html.indexOf("pom.xml"));
});

// ---------------------------------------------------------------- documentation sources

test("every code fence in the documentation declares a language the portal renders", () => {
  const supported = new Set(["text", "output", "log", "jsonl", "txt", "tree", "architecture", "flow", "http", "bash", "sh", "shell", "console", "powershell", "ps1", "pwsh", "json", "jsonc", "yaml", "yml", "xml", "html", "pom", "sql", "typescript", "ts", "javascript", "js", "mjs", "cjs", "java", "dockerfile", "ini", "properties", "env", "dotenv", "markdown", "md", "pso-example"]);
  const bad: string[] = [];
  for (const f of walk(docs)) {
    const id = relative(docs, f).replace(/\\/g, "/");
    if (id.startsWith("ai-context/")) continue;
    let open = false;
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      const m = /^```(\S*)/.exec(line);
      if (!m) continue;
      if (!open) { open = true; if (!supported.has(m[1]!)) bad.push(`${id}:${i + 1} "${m[1]}"`); } else open = false;
    }
  }
  assert.deepEqual(bad, []);
});

test("every file tree in the documentation parses, and every tree on the CRUD page is well formed", () => {
  for (const f of walk(docs)) {
    const id = relative(docs, f).replace(/\\/g, "/");
    if (id.startsWith("ai-context/")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/```tree[^\n]*\n([\s\S]*?)```/g)) {
      const html = fileTree(m[1]!);
      assert.ok((html.match(/role="treeitem"/g) ?? []).length >= 2, `${id}: a tree needs at least two entries`);
      for (const line of m[1]!.split("\n").filter(Boolean)) assert.ok(/^( {2})*\S/.test(line), `${id}: tree indentation must be multiples of two spaces: "${line}"`);
    }
  }
});

// ---------------------------------------------------------------- the tutorial against the real CLI

test("the CRUD tutorial: generated trees, application.yml and gateway files are exactly what the CLI produces", { timeout: 240_000 }, async () => {
  const base = tmp("pso-crud-doc-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop", "--layout", "flat")).code, 0);
  const shop = join(base, "shop");
  assert.equal((await pso(shop, "create", "service", "catalog", "--structure", "legacy", "--db", "postgres", "--port", "8081")).code, 0);
  assert.equal((await pso(shop, "create", "orchestrator", "gateway", "--structure", "legacy")).code, 0);

  // 2. application.yml: the example file is the generated one plus the two snippets, nothing else
  const yml = readFileSync(join(shop, "catalog/src/main/resources/application.yml"), "utf8");
  const pool = readFileSync(join(example, "datasource-pool.yml"), "utf8"), jpa = readFileSync(join(example, "jpa.yml"), "utf8");
  const expected = yml.replace("    password: ${DB_PASSWORD:}\n", `    password: \${DB_PASSWORD:}\n${pool}`).replace("  flyway:\n    enabled: true\n", `  flyway:\n    enabled: true\n${jpa}`);
  assert.equal(readFileSync(join(example, "application.yml"), "utf8"), expected);

  // 3. the orchestrator files are what make:module, make:controller and make:route generate, and they compile
  const run = async (...a: string[]) => { const r = await pso(shop, ...a); assert.equal(r.code, 0, r.err + r.out); };
  await run("make:module", "products", "--service", "gateway");
  await run("make:controller", "products", "--service", "gateway");
  const route = (action: string, method: string, path: string, scopes: string) => run("make:route", "products", action, "--method", method, "--path", path, "--guard", "jwt", "--scopes", scopes, "--upstream", "catalog", "--service", "gateway");
  await route("list", "GET", "/", "products:read");
  await route("findOne", "GET", "/:id", "products:read");
  await route("create", "POST", "/", "products:write");
  await route("replace", "PUT", "/:id", "products:write");
  await route("remove", "DELETE", "/:id", "products:write");
  for (const f of ["MODULE.pso.ts", "ROUTES.pso.ts", "products.controller.ts"]) {
    assert.equal(readFileSync(join(example, "gateway/src/routes/products", f), "utf8"), readFileSync(join(shop, "gateway/src/routes/products", f), "utf8"), f);
  }
  // 1. every path the tutorial's trees mark as "generated" exists after the commands it names
  const tutorial = page("architecture/manual-crud-0-1");
  const trees = [...tutorial.matchAll(/```tree title="([^"]*)"\n([\s\S]*?)```|```tree\n([\s\S]*?)```/g)];
  assert.ok(trees.length >= 4, "the tutorial shows its project structures as trees");
  let checked = 0;
  for (const t of trees) {
    const src = (t[2] ?? t[3])!;
    const stack: string[] = [];
    for (const line of src.split("\n").filter(Boolean)) {
      const depth = /^ */.exec(line)![0].length / 2;
      const [rawName, note = ""] = line.trim().split(/\s+#\s+/);
      const name = rawName!.replace(/\/$/, "");
      stack.length = depth; stack[depth] = name;
      if (!/^generated/.test(note)) continue;
      const rel = stack.join("/");
      const root = rel.startsWith("shop/") ? base : rel.startsWith("catalog/") ? shop : rel.startsWith("gateway/") ? shop : undefined;
      // trees titled "catalog/ after ..." start at the service folder; the first line is the folder itself
      const candidate = root === undefined ? undefined : join(root, rel);
      if (candidate === undefined) continue;
      assert.ok(existsSync(candidate), `the tutorial says ${rel} is generated, but the CLI did not create ${candidate}`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} generated paths`);

  // 3b. the two routes added by the extensions section (search and PATCH) are generated the same way
  await route("search", "GET", "/search", "products:read");
  await route("patch", "PATCH", "/:id", "products:write");
  for (const f of ["MODULE.pso.ts", "ROUTES.pso.ts", "products.controller.ts"]) {
    assert.equal(readFileSync(join(example, "..", "spring-crud-extensions", "gateway/src/routes/products", f), "utf8"), readFileSync(join(shop, "gateway/src/routes/products", f), "utf8"), "extension " + f);
  }
  assert.equal((await pso(shop, "validate")).code, 0);
  const listed = (await pso(shop, "routes:list")).out;
  for (const r of ["GET     /products ", "POST    /products ", "GET     /products/:id", "PUT     /products/:id", "DELETE  /products/:id"]) assert.ok(listed.includes(r), `routes:list shows ${r}`);
  prepare(join(shop, "gateway")); // the generated orchestrator, with the tutorial's module, compiles with the real TypeScript compiler
  assert.ok(existsSync(join(shop, "gateway/dist/routes/products/MODULE.pso.js")));
});

test("the tutorial's development scripts, compose file and request script are valid", () => {
  for (const f of ["dev-token.mjs", "dev-jwks.mjs"]) assert.equal(spawnSync(process.execPath, ["--check", join(example, f)], { encoding: "utf8" }).status, 0, f);
  const compose = readFileSync(join(example, "postgres.compose.yml"), "utf8");
  assert.match(compose, /image: postgres:16-alpine/);
  assert.match(compose, /127\.0\.0\.1:5432:5432/, "the database listens on loopback only");
  const tutorial = page("architecture/manual-crud-0-1");
  for (const [env, value] of [["POSTGRES_DB", "catalog"], ["POSTGRES_USER", "catalog"], ["POSTGRES_PASSWORD", "catalog-dev"]] as const) assert.match(compose, new RegExp(`${env}: ${value}`));
  assert.ok(tutorial.includes("DB_PASSWORD=catalog-dev") && tutorial.includes("jdbc:postgresql://127.0.0.1:5432/catalog"), "the tutorial's connection variables match the compose file");
  // F-12: the tutorial's infrastructure file is not the file `pso docker:init` generates, and every command names it
  assert.ok(tutorial.includes("infra/postgres.compose.yml"));
  assert.doesNotMatch(tutorial, /^docker compose (up|exec|down|ps)\b/m, "no command relies on a docker-compose.yml in the workspace root");
  assert.doesNotMatch(tutorial, /title="docker-compose\.yml/, "the tutorial does not ask for a file named like the generated deployment");
  const docker = spawnSync("docker", ["compose", "-f", join(example, "postgres.compose.yml"), "config", "-q"], { encoding: "utf8", shell: process.platform === "win32" });
  if (docker.error === undefined && docker.status !== null && !/not found|not recognized/i.test(docker.stderr)) assert.equal(docker.status, 0, docker.stderr);
  const sh = readFileSync(join(example, "crud-requests.sh"), "utf8");
  for (const op of ["-X POST", "-X PUT", "-X DELETE"]) assert.ok(sh.includes(op), op);
});

