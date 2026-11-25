import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspace } from "@pso/core";
import { INFRA_HOOKS } from "../src/commands-infra.ts";
import { pso, tmp } from "./helpers.ts";

// The identity provider must know the scopes the API requires: those of the orchestrator's routes count, not only the frontends', and
// a development user's scopes may themselves contain ":" (products:read).
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

test("route scopes reach the identity provider, and --users name:scope+scope keeps the colons of a scope", { timeout: 120_000 }, async () => {
  const base = tmp("pso-scopes-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "service", "catalog")).code, 0);
  assert.equal((await pso(ws, "create", "orchestrator", "gateway")).code, 0);
  const { config } = loadWorkspace(ws);
  assert.deepEqual(INFRA_HOOKS.frontends!(ws, config!).scopes, ["products:read", "products:write"], "a workspace without a frontend still declares its API scopes");
  const init = await pso(ws, "infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana,bob:products:read,cy:products:read+products:write");
  assert.equal(init.code, 0, init.out + init.err);
  const contract = JSON.parse(readFileSync(join(ws, "pso.infra.json"), "utf8")) as { identity: { users: Array<{ username: string; scopes: string[] }> } };
  assert.deepEqual(contract.identity.users, [
    { username: "ana", scopes: ["*"] },
    { username: "bob", scopes: ["products:read"] },
    { username: "cy", scopes: ["products:read", "products:write"] },
  ]);
});
