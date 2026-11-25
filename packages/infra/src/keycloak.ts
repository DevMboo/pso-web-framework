import { InfraError } from "./contract.ts";
import { netRequest } from "./net.ts";
import { renderRealm } from "./render.ts";
import { lookupSecret, redact, rememberSecret } from "./secrets.ts";
import type { Topology } from "./topology.ts";

/**
 * Reconciliation of an already provisioned Keycloak realm through its administration API (the import only runs on an empty realm).
 *
 * Ownership: a client or role PSO created carries the attribute `pso.managed=true` (written in the generated realm and on every object the
 * reconciliation creates). Only those are compared and changed. A client with the same clientId WITHOUT the marker belongs to someone else
 * and is reported, never modified. Users, their credentials and sessions are never changed; client secrets are never sent, so they are
 * never reset; the realm is never recreated.
 *
 * Changes are classified: creating a missing client, role, mapper or development user is routine; changing an existing managed client
 * (redirect URIs, web origins, flows, mappers) or removing an orphaned managed client is SENSITIVE and needs explicit authorization.
 */
export const MANAGED_ATTR = "pso.managed";
export type IdentityChangeKind = "create-realm" | "create-client" | "update-client" | "create-mapper" | "update-mapper" | "create-role" | "create-user" | "add-user-roles" | "prune-client" | "external-conflict" | "orphan";
export interface IdentityChange { kind: IdentityChangeKind; target: string; sensitive: boolean; detail: string }
export interface IdentityPlan { realm: string; reachable: boolean; changes: IdentityChange[]; inSync: boolean }
export interface AdminAccess { base: string; ca?: string; resolve?: Record<string, string> }

type Json = Record<string, unknown>;
const FIELDS = ["publicClient", "standardFlowEnabled", "implicitFlowEnabled", "directAccessGrantsEnabled", "serviceAccountsEnabled", "fullScopeAllowed", "enabled"] as const;
const sameSet = (a: unknown, b: unknown) => JSON.stringify([...((a as string[]) ?? [])].sort()) === JSON.stringify([...((b as string[]) ?? [])].sort());

class Admin {
  private token = "";
  private readonly a: AdminAccess;
  constructor(a: AdminAccess) { this.a = a; }
  async login(user: string, password: string): Promise<void> {
    const body = new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: user, password }).toString();
    const r = await netRequest({ url: `${this.a.base}/realms/master/protocol/openid-connect/token`, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) }, body, ...(this.a.ca ? { ca: this.a.ca } : {}), ...(this.a.resolve ? { resolve: this.a.resolve } : {}), timeoutMs: 20_000 });
    if (r.status !== 200) throw new InfraError(`the identity provider refused the administrator sign-in (HTTP ${r.status})`, "PSO_IDP_ADMIN_AUTH", "Is the idp-admin secret the one Keycloak was started with?");
    this.token = (JSON.parse(r.body.toString()) as { access_token: string }).access_token;
    rememberSecret(this.token);
  }
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; headers: Record<string, string | string[]> }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = await netRequest({ url: `${this.a.base}/admin/realms${path}`, method, headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}) }, ...(payload ? { body: payload } : {}), ...(this.a.ca ? { ca: this.a.ca } : {}), ...(this.a.resolve ? { resolve: this.a.resolve } : {}), timeoutMs: 20_000 });
    let json: unknown = undefined; try { json = r.body.length ? JSON.parse(r.body.toString()) : undefined; } catch { /* not JSON */ }
    if (r.status >= 400 && r.status !== 404) throw new InfraError(`Keycloak administration API ${method} ${path}: HTTP ${r.status} ${redact(r.body.toString().slice(0, 200))}`, "PSO_IDP_ADMIN_API");
    return { status: r.status, json, headers: r.headers };
  }
}

/** The realm the declarations describe, as Keycloak representations, with the ownership marker on every client and role. */
export function desiredRealm(t: Topology): { realm: Json; clients: Json[]; roles: Json[]; users: Json[] } {
  const r = JSON.parse(renderRealm(t)) as Json & { clients: Json[]; roles: { realm: Json[] }; users: Json[] };
  return { realm: r, clients: r.clients, roles: r.roles.realm, users: r.users };
}

async function adminFor(root: string, t: Topology, access: AdminAccess): Promise<Admin> {
  if (t.identity?.provider !== "keycloak") throw new InfraError(`environment "${t.env}" does not use a PSO-managed Keycloak`, "PSO_INFRA_IDENTITY_KIND");
  const pw = lookupSecret(root, t.env, t.secretProvider, "idp-admin", t.decl.secrets?.dir);
  if (!pw.value) throw new InfraError("the identity provider's administrator secret (idp-admin) is not available here", "PSO_IDP_ADMIN_SECRET", t.kind === "development" ? `pso infra:apply --env ${t.env}` : "Provide it through the environment's secret provider on this machine to reconcile the realm");
  rememberSecret(pw.value);
  const a = new Admin(access);
  await a.login("admin", pw.value);
  return a;
}

export async function planIdentity(root: string, t: Topology, access: AdminAccess): Promise<IdentityPlan> {
  const want = desiredRealm(t);
  const realm = String(want.realm["realm"]);
  let admin: Admin;
  try { admin = await adminFor(root, t, access); }
  catch (e) {
    // configuration problems are errors; a provider that does not answer is a state the plan reports
    if (e instanceof InfraError && e.code !== "PSO_IDP_ADMIN_AUTH") throw e;
    return { realm, reachable: false, changes: [{ kind: "external-conflict", target: realm, sensitive: false, detail: `the identity provider is not reachable or refused the administrator: ${redact((e as Error).message)}` }], inSync: false };
  }
  return (await diff(admin, t, want)).plan;
}

async function diff(admin: Admin, t: Topology, want: ReturnType<typeof desiredRealm>): Promise<{ plan: IdentityPlan; current: Map<string, Json> }> {
  const realm = String(want.realm["realm"]);
  const changes: IdentityChange[] = [];
  const current = new Map<string, Json>();
  const rr = await admin.call("GET", `/${realm}`);
  if (rr.status === 404) { changes.push({ kind: "create-realm", target: realm, sensitive: false, detail: "the realm does not exist: it is created from the declarations" }); return { plan: { realm, reachable: true, changes, inSync: false }, current }; }
  const clients = (await admin.call("GET", `/${realm}/clients?max=1000`)).json as Json[];
  for (const c of clients) current.set(String(c["clientId"]), c);
  for (const w of want.clients) {
    const id = String(w["clientId"]);
    const have = current.get(id);
    if (!have) { changes.push({ kind: "create-client", target: id, sensitive: false, detail: `${w["publicClient"] ? "public" : "confidential"} client, redirect URIs ${((w["redirectUris"] as string[]) ?? []).join(", ") || "-"}` }); continue; }
    const managed = (have["attributes"] as Json | undefined)?.[MANAGED_ATTR] === "true";
    if (!managed) { changes.push({ kind: "external-conflict", target: id, sensitive: false, detail: `a client "${id}" exists that PSO did not create (no ${MANAGED_ATTR} attribute): it is left as it is. Rename the frontend's clientId in pso.infra.json, or mark the client as managed in Keycloak to hand it over` }); continue; }
    const diffs: string[] = [];
    if (!sameSet(have["redirectUris"], w["redirectUris"])) diffs.push(`redirect URIs ${JSON.stringify(have["redirectUris"])} -> ${JSON.stringify(w["redirectUris"])}`);
    if (!sameSet(have["webOrigins"], w["webOrigins"])) diffs.push(`web origins ${JSON.stringify(have["webOrigins"])} -> ${JSON.stringify(w["webOrigins"])}`);
    for (const f of FIELDS) if (w[f] !== undefined && have[f] !== w[f]) diffs.push(`${f} ${String(have[f])} -> ${String(w[f])}`);
    for (const [k, v] of Object.entries((w["attributes"] as Json) ?? {})) if ((have["attributes"] as Json | undefined)?.[k] !== v) diffs.push(`attribute ${k}`);
    if (diffs.length) changes.push({ kind: "update-client", target: id, sensitive: true, detail: diffs.join("; ") });
    const mappers = ((have["protocolMappers"] as Json[]) ?? []);
    for (const m of (w["protocolMappers"] as Json[]) ?? []) {
      const hm = mappers.find((x) => x["name"] === m["name"]);
      if (!hm) changes.push({ kind: "create-mapper", target: `${id}/${String(m["name"])}`, sensitive: false, detail: String(m["protocolMapper"]) });
      else if (JSON.stringify(hm["config"]) !== JSON.stringify({ ...(hm["config"] as Json), ...(m["config"] as Json) }) || hm["protocolMapper"] !== m["protocolMapper"]) changes.push({ kind: "update-mapper", target: `${id}/${String(m["name"])}`, sensitive: true, detail: "configuration differs from the declarations" });
    }
  }
  const wanted = new Set(want.clients.map((c) => String(c["clientId"])));
  for (const [id, c] of current) if ((c["attributes"] as Json | undefined)?.[MANAGED_ATTR] === "true" && !wanted.has(id)) changes.push({ kind: "orphan", target: id, sensitive: true, detail: "a PSO-managed client the declarations no longer contain (its frontend was removed): kept unless --prune --yes" });
  for (const role of want.roles) {
    const r = await admin.call("GET", `/${realm}/roles/${encodeURIComponent(String(role["name"]))}`);
    if (r.status === 404) changes.push({ kind: "create-role", target: String(role["name"]), sensitive: false, detail: "scope role used by the declarations" });
  }
  if (t.kind === "development") for (const u of want.users) {
    const found = ((await admin.call("GET", `/${realm}/users?exact=true&username=${encodeURIComponent(String(u["username"]))}`)).json as Json[]) ?? [];
    if (!found.length) { changes.push({ kind: "create-user", target: String(u["username"]), sensitive: false, detail: "development user (password from its secret)" }); continue; }
    const have = ((await admin.call("GET", `/${realm}/users/${String(found[0]!["id"])}/role-mappings/realm`)).json as Json[] ?? []).map((x) => String(x["name"]));
    const missing = ((u["realmRoles"] as string[]) ?? []).filter((x) => !have.includes(x));
    if (missing.length) changes.push({ kind: "add-user-roles", target: String(u["username"]), sensitive: false, detail: `adds ${missing.join(", ")} (existing roles and credentials are kept)` });
  }
  return { plan: { realm, reachable: true, changes, inSync: !changes.some((c) => c.kind !== "external-conflict") }, current };
}

export interface IdentityApplyResult { plan: IdentityPlan; applied: IdentityChange[]; skipped: IdentityChange[] }

/** Applies the plan. Sensitive changes need `authorizeSensitive`; orphans are removed only with `prune` (and authorization). */
export async function applyIdentity(root: string, t: Topology, access: AdminAccess, o: { authorizeSensitive?: boolean; prune?: boolean } = {}): Promise<IdentityApplyResult> {
  const admin = await adminFor(root, t, access);
  const want = desiredRealm(t);
  const { plan, current } = await diff(admin, t, want);
  const realm = plan.realm;
  const applied: IdentityChange[] = [], skipped: IdentityChange[] = [];
  const secretFor = (name: string) => lookupSecret(root, t.env, t.secretProvider, name, t.decl.secrets?.dir).value;
  const resolvePlaceholders = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/\$\{PSO_USER_([A-Z0-9_]+)_PASSWORD\}/g, (_m, u: string) => { const s = secretFor(`user-${u.toLowerCase().replace(/_/g, "-")}`); if (s) rememberSecret(s); return s ?? ""; }).replace(/\$\{PSO_API_CLIENT_SECRET\}/g, () => secretFor("idp-api-client") ?? ""));
  for (const c of plan.changes) {
    if (c.kind === "external-conflict") { skipped.push(c); continue; }
    if ((c.sensitive && !o.authorizeSensitive) || (c.kind === "orphan" && !o.prune)) { skipped.push(c); continue; }
    switch (c.kind) {
      case "create-realm": await admin.call("POST", "", resolvePlaceholders(want.realm)); break;
      case "create-client": await admin.call("POST", `/${realm}/clients`, resolvePlaceholders(want.clients.find((x) => x["clientId"] === c.target))); break;
      case "update-client": {
        const have = current.get(c.target)!, w = want.clients.find((x) => x["clientId"] === c.target)!;
        // only the managed fields are overlaid; the secret is never sent (so it is never reset) and unknown fields are kept
        const { secret: _s, protocolMappers: _pm, ...wNoSecret } = w;
        const merged = { ...have, ...wNoSecret, attributes: { ...((have["attributes"] as Json) ?? {}), ...((w["attributes"] as Json) ?? {}) } };
        delete (merged as Json)["secret"]; delete (merged as Json)["protocolMappers"];
        await admin.call("PUT", `/${realm}/clients/${String(have["id"])}`, merged);
        break;
      }
      case "create-mapper": case "update-mapper": {
        const [cid, name] = c.target.split("/") as [string, string];
        const have = current.get(cid)!, m = ((want.clients.find((x) => x["clientId"] === cid)!["protocolMappers"] as Json[]) ?? []).find((x) => x["name"] === name)!;
        const existing = ((have["protocolMappers"] as Json[]) ?? []).find((x) => x["name"] === name);
        if (existing) await admin.call("PUT", `/${realm}/clients/${String(have["id"])}/protocol-mappers/models/${String(existing["id"])}`, { ...existing, ...m, id: existing["id"] });
        else await admin.call("POST", `/${realm}/clients/${String(have["id"])}/protocol-mappers/models`, m);
        break;
      }
      case "create-role": await admin.call("POST", `/${realm}/roles`, want.roles.find((x) => x["name"] === c.target)); break;
      case "create-user": await admin.call("POST", `/${realm}/users`, resolvePlaceholders({ ...want.users.find((x) => x["username"] === c.target)!, realmRoles: undefined })); /* falls through to the role mapping */ // eslint-disable-line no-fallthrough
      // eslint-disable-next-line no-fallthrough
      case "add-user-roles": {
        const u = want.users.find((x) => x["username"] === c.target)!;
        const found = ((await admin.call("GET", `/${realm}/users?exact=true&username=${encodeURIComponent(c.target)}`)).json as Json[]) ?? [];
        const roles = await Promise.all(((u["realmRoles"] as string[]) ?? []).map(async (n) => (await admin.call("GET", `/${realm}/roles/${encodeURIComponent(n)}`)).json as Json));
        if (found[0]) await admin.call("POST", `/${realm}/users/${String(found[0]["id"])}/role-mappings/realm`, roles.filter(Boolean));
        break;
      }
      case "orphan": case "prune-client": await admin.call("DELETE", `/${realm}/clients/${String(current.get(c.target)!["id"])}`); break;
    }
    applied.push(c);
  }
  return { plan, applied, skipped };
}
