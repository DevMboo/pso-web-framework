import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectNodeStructure, detectSpringStructure, discover, matchesPath, nodeLayout, springLayout } from "../src/index.ts";

const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "pso-structure-"));
  for (const [rel, body] of Object.entries(files)) { const f = join(root, ...rel.split("/")); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); }
  return root;
};

test("matchesPath: * is one segment, ** any number", () => {
  assert.ok(matchesPath(["modules", "products", "controllers"], ["modules/*/controllers"]));
  assert.ok(!matchesPath(["modules", "products", "x", "controllers"], ["modules/*/controllers"]));
  assert.ok(matchesPath(["shared", "a", "b"], ["shared/**"]));
  assert.ok(matchesPath(["shared"], ["shared", "shared/**"]));
  assert.ok(!matchesPath(["modules"], ["modules/*"]));
});

test("orchestrator structure: modular, legacy, default, mixed, declaration contradicted", () => {
  const modular = project({ "src/.app/guards/jwt.guard.ts": "", "src/modules/products/MODULE.pso.ts": "", "src/modules/products/routes/ROUTES.pso.ts": "" });
  const legacy = project({ "src/guards/jwt.guard.ts": "", "src/routes/product/MODULE.pso.ts": "" });
  const empty = project({ "src/main.ts": "" });
  const mixed = project({ "src/.app/guards/jwt.guard.ts": "", "src/routes/product/MODULE.pso.ts": "" });
  try {
    assert.equal(detectNodeStructure(join(modular, "src")).structure, "modular");
    assert.equal(detectNodeStructure(join(legacy, "src")).structure, "legacy");
    const d = detectNodeStructure(join(empty, "src"));
    assert.deepEqual([d.structure, d.source], ["modular", "default"], "a project with no marker yet gets the official structure");
    assert.match(detectNodeStructure(join(mixed, "src")).problems[0] ?? "", /mixes the modular structure/);
    assert.match(detectNodeStructure(join(legacy, "src"), "modular").problems[0] ?? "", /declares structure "modular" but the files follow "legacy"/);
    assert.deepEqual(detectNodeStructure(join(empty, "src"), "legacy").structure, "legacy", "an empty project follows its declaration");
    // .gitkeep placeholders are not evidence: the 0.1 template's empty folders do not make an empty project legacy
    const placeholders = project({ "src/configs/.gitkeep": "", "src/main.ts": "" });
    try { assert.equal(detectNodeStructure(join(placeholders, "src")).structure, "modular"); } finally { rmSync(placeholders, { recursive: true, force: true }); }
  } finally { for (const r of [modular, legacy, empty, mixed]) rmSync(r, { recursive: true, force: true }); }
});

test("modular discovery: module-local kinds in their module, application-wide kinds in .app, misplaced files reported", () => {
  const root = project({
    "src/main.ts": "",
    "src/.app/guards/jwt.guard.ts": "", "src/.app/interceptors/timing.interceptor.ts": "", "src/.app/configs/app.config.ts": "", "src/.app/decorators/audited.decorator.ts": "",
    "src/modules/products/MODULE.pso.ts": "", "src/modules/products/routes/ROUTES.pso.ts": "",
    "src/modules/products/controllers/product.controller.ts": "", "src/modules/products/services/product.service.ts": "",
    "src/modules/products/providers/product.provider.ts": "", "src/modules/products/contracts/product.contract.ts": "",
    "src/modules/products/dto/request/create-product.dto.ts": "", "src/modules/products/dto/response/product.dto.ts": "", "src/modules/products/mappers/product.mapper.ts": "",
    "src/shared/money.service.ts": "",
    "src/modules/products/product.controller.ts": "", // the 0.1 place of a controller: misplaced here
    "src/.app/product.service.ts": "", // business code in .app: misplaced
  });
  try {
    const d = discover(root, "node");
    assert.equal(d.structure, "modular");
    const keys = d.resources.map((r) => r.key);
    for (const k of ["module:products", "route-registry:products", "controller:products/product", "service:products/product", "provider:products/product", "type-contract:products/product", "dto:products/create-product", "dto:products/product", "mapper:products/product", "guard:jwt", "interceptor:timing", "config:app", "decorator:audited", "service:money"]) assert.ok(keys.includes(k), `missing ${k} in ${keys.join(", ")}`);
    const misplaced = d.diagnostics.filter((x) => x.code === "PSO_MISPLACED_RESOURCE").map((x) => x.file);
    assert.deepEqual(misplaced.sort(), ["src/.app/product.service.ts", "src/modules/products/product.controller.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("layered Java discovery: application/ and infrastructure/ packages under the base package; no providers or modules", () => {
  const P = "src/main/java/com/example/products";
  const root = project({
    [`${P}/Application.java`]: "package com.example.products;\n@SpringBootApplication\npublic class Application {}\n",
    [`${P}/application/rest/ProductController.java`]: "", [`${P}/application/service/ProductService.java`]: "",
    [`${P}/application/dto/request/CreateProductRequest.java`]: "", [`${P}/application/dto/response/ProductResponse.java`]: "",
    [`${P}/application/mapper/ProductMapper.java`]: "", [`${P}/infrastructure/persistence/ProductRepository.java`]: "",
    [`${P}/infrastructure/entity/ProductEntity.java`]: "", [`${P}/shared/exception/ResourceNotFoundException.java`]: "",
    [`${P}/application/service/ProductRepository.java`]: "", // a repository in the service package: misplaced
  });
  try {
    const d = discover(root, "spring-boot");
    assert.equal(d.structure, "layered");
    const keys = d.resources.map((r) => r.key);
    for (const k of ["controller:ProductController", "service:ProductService", "request:CreateProductRequest", "response:ProductResponse", "mapper:ProductMapper", "repository:ProductRepository", "entity:ProductEntity", "exception:ResourceNotFoundException"]) assert.ok(keys.includes(k), `missing ${k}`);
    assert.deepEqual(d.diagnostics.filter((x) => x.code === "PSO_MISPLACED_RESOURCE").map((x) => x.file), [`${P}/application/service/ProductRepository.java`]);
    assert.equal(springLayout("layered").pkg("controller"), "application/rest");
    assert.equal(springLayout("layered").pkg("port"), undefined, "the layered structure has no hexagonal ports");
    assert.equal(springLayout("legacy").pkg("controller"), "routes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Spring structure detection: layered, legacy (incl. classes directly in application/), mixed", () => {
  const base = (files: Record<string, string>) => project(Object.fromEntries(Object.entries(files).map(([k, v]) => [`pkg/${k}`, v])));
  const layered = base({ "application/rest/AController.java": "" });
  const legacy = base({ "application/PingService.java": "", "routes/PingController.java": "" });
  const mixed = base({ "application/rest/AController.java": "", "routes/PingController.java": "" });
  try {
    assert.equal(detectSpringStructure(join(layered, "pkg")).structure, "layered");
    assert.equal(detectSpringStructure(join(legacy, "pkg")).structure, "legacy");
    assert.match(detectSpringStructure(join(mixed, "pkg")).problems[0] ?? "", /mixes the layered structure/);
    const d = discover(mixed, "spring-boot");
    void d;
  } finally { for (const r of [layered, legacy, mixed]) rmSync(r, { recursive: true, force: true }); }
});

test("layouts: modular components live in .app, modules in modules/ with routes/ROUTES.pso; legacy unchanged", () => {
  assert.equal(nodeLayout("modular").component("guards"), ".app/guards");
  assert.equal(nodeLayout("modular").routesFile, "routes/ROUTES.pso");
  assert.equal(nodeLayout("modular").moduleDir("controllers"), "controllers");
  assert.equal(nodeLayout("legacy").component("guards"), "guards");
  assert.equal(nodeLayout("legacy").modulesDir, "routes");
  assert.equal(nodeLayout("legacy").moduleDir("controllers"), "");
});
