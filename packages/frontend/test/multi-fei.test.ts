import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, feiOf, loadFrontends, renderTree, validateEcosystem } from "../src/node.ts";

/** A workspace with two independent shells: shop (public catalog, protected cart) and admin (permission-protected users). */
function workspace(over: { cartHost?: string; adminPort?: number; usersRegisteredIn?: "admin" | "shop"; shopAuth?: "jwt" | "none" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pso-multi-fei-"));
  const w = (rel: string, text: string) => { const f = join(root, ...rel.split("/")); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text); };
  const fei = (name: string, port: number, mfs: string, auth = "jwt") => {
    w(`frontend/${name}/FEI.pso.ts`, `import { defineFEI } from "@pso/frontend";\nexport default defineFEI({ name: "${name}", server: { port: ${port} }, orchestrator: { service: "gateway" }, security: { authentication: "${auth}"${auth === "none" ? ", session: \"none\"" : ""} }, ${auth === "none" ? "middlewares: [\"context\"], " : ""}microfrontends: [${mfs}] });\n`);
    w(`frontend/${name}/ROUTES.pso.ts`, `import { defineFrontendRoutes } from "@pso/frontend";\nexport default defineFrontendRoutes({ routes: [{ path: "/", page: "./src/pages/Home.tsx", public: true }] });\n`);
    w(`frontend/${name}/src/pages/Home.tsx`, "export default function Home() { return null; }\n");
  };
  const mei = (name: string, host: string, port: number, scopes: string[] = []) => {
    w(`frontend/${name}/MEI.pso.ts`, `import { defineMEI } from "@pso/frontend";\nexport default defineMEI({ name: "${name}", host: "${host}", server: { port: ${port} }, orchestrator: { service: "gateway" }, security: { inheritFromHost: true, scopes: ${JSON.stringify(scopes)} } });\n`);
    w(`frontend/${name}/ROUTES.pso.ts`, `import { defineFrontendRoutes } from "@pso/frontend";\nexport default defineFrontendRoutes({ routes: [{ path: "/", page: "./src/pages/List.tsx" }, { path: "/:id", page: "./src/pages/List.tsx" }] });\n`);
    w(`frontend/${name}/src/pages/List.tsx`, "export default function List() { return null; }\n");
    w(`frontend/${name}/src/module.tsx`, "export default {};\n");
  };
  const usersIn = over.usersRegisteredIn ?? "admin";
  const usersEntry = `{ name: "mei-users", path: "/users", scopes: ["users:admin"] }`;
  fei("fei-shop", 4200, [`{ name: "mei-catalog", path: "/catalog", public: true }`, `{ name: "mei-cart", path: "/cart", scopes: ["cart:write"] }`, ...(usersIn === "shop" ? [usersEntry] : [])].join(", "), over.shopAuth);
  fei("fei-admin", over.adminPort ?? 4300, usersIn === "admin" ? usersEntry : "");
  mei("mei-catalog", "fei-shop", 9000);
  mei("mei-cart", over.cartHost ?? "fei-shop", 9001, ["cart:write"]);
  mei("mei-users", "fei-admin", 9002, ["users:admin"]);
  const projects = [
    { kind: "fei" as const, name: "fei-shop", path: "frontend/fei-shop", port: 4200 },
    { kind: "fei" as const, name: "fei-admin", path: "frontend/fei-admin", port: over.adminPort ?? 4300 },
    { kind: "mei" as const, name: "mei-catalog", path: "frontend/mei-catalog", port: 9000 },
    { kind: "mei" as const, name: "mei-cart", path: "frontend/mei-cart", port: 9001 },
    { kind: "mei" as const, name: "mei-users", path: "frontend/mei-users", port: 9002 },
  ];
  return { root, loaded: loadFrontends(root, projects) };
}
const errors = (r: ReturnType<typeof validateEcosystem>) => r.diagnostics.filter((d) => d.severity === "error");

test("two independent FEIs validate, each with its own MEIs and routes", () => {
  const { root, loaded } = workspace();
  assert.equal(loaded.feis.length, 2);
  assert.equal(loaded.fei, undefined, "the compatibility alias is only set when there is exactly one FEI");
  const r = validateEcosystem(root, loaded);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.feis.sort(), ["fei-admin", "fei-shop"]);
  // both shells declare "/" public: no conflict, they are separate applications
  assert.deepEqual(r.routes.filter((x) => x.path === "/").map((x) => x.app).sort(), ["fei-admin", "fei-shop"]);
  assert.deepEqual(r.routes.filter((x) => x.owner === "mei-users").map((x) => x.app), ["fei-admin", "fei-admin"]);
  assert.equal(feiOf(loaded, "mei-cart")?.project.name, "fei-shop");
  assert.equal(feiOf(loaded, "admin")?.project.name, "fei-admin");
  const tree = renderTree(buildGraph(loaded));
  assert.match(tree, /fei-shop \(:4200\)[\s\S]*mei-catalog[\s\S]*fei-admin \(:4300\)[\s\S]*mei-users/);
});

test("a MEI registered in a shell it is not built for is rejected", () => {
  const { root, loaded } = workspace({ usersRegisteredIn: "shop" });
  const codes = errors(validateEcosystem(root, loaded)).map((d) => d.code);
  assert.ok(codes.includes("PSO_MEI_HOST_MISMATCH"), codes.join(","));
});

test("a MEI whose host is not a FEI of the workspace is rejected", () => {
  const { root, loaded } = workspace({ cartHost: "fei-nowhere" });
  const codes = errors(validateEcosystem(root, loaded)).map((d) => d.code);
  assert.ok(codes.includes("PSO_MEI_HOST_UNKNOWN"), codes.join(","));
});

test("two shells cannot share a development port", () => {
  const { root, loaded } = workspace({ adminPort: 4200 });
  const ds = errors(validateEcosystem(root, loaded)).filter((d) => d.code === "PSO_FRONTEND_PORT_CONFLICT");
  assert.equal(ds.length, 1);
  assert.match(ds[0]!.message, /fei-admin and fei-shop both use port 4200/);
});

test("authentication policies are independent per FEI, and contradictions are caught per FEI", () => {
  // shop without authentication, but its cart MEI needs a scope: contradiction in shop only
  const { root, loaded } = workspace({ shopAuth: "none" });
  const r = validateEcosystem(root, loaded);
  const contra = r.diagnostics.filter((d) => d.code === "PSO_FEI_AUTH_CONTRADICTION");
  assert.ok(contra.length >= 1);
  assert.ok(contra.every((d) => (d.file ?? "").includes("fei-shop")), JSON.stringify(contra));
});
