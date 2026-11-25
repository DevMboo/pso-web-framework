import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { findWorkspaceRoot } from "@pso/core";
import {
  Cloud, CloudError, declFor, discoverDeclarations, redactText, redactValue, servicesOf,
  type DeploymentDecl, type Plan,
} from "@pso/deploy";

/**
 * The Studio side of Cloud Lifecycle & Operations: the local Studio server is the TRUSTED backend. It owns the credential store and
 * the SSH/agent sessions and calls the same `Cloud` facade as the CLI, so both enforce the same policies (the server's agent
 * decides; neither client contains deployment rules). The browser renderer only ever receives sanitized data and opaque references:
 * a typed password is sent once to this process, stored in the protected credential store, and never returned.
 *
 * Remote management is OFF unless Studio was started with `--remote`. Mutating requests additionally need the Studio access cookie,
 * a same-origin `Origin` header and the `x-pso-studio` header (CSRF defence).
 */
export interface CloudApiOptions { root: string; enabled: boolean; cloud?: Cloud }
export interface CloudResult { status: number; body: unknown }

const ok = (body: unknown, status = 200): CloudResult => ({ status, body: redactValue(body) });
const fail = (status: number, message: string, code = "ERROR", hint?: string): CloudResult => ({ status, body: { error: redactText(message), code, ...(hint ? { hint } : {}) } });

export class StudioCloud {
  readonly cloud: Cloud; readonly root: string; readonly enabled: boolean;
  constructor(o: CloudApiOptions) { this.root = findWorkspaceRoot(o.root) ?? o.root; this.enabled = o.enabled; this.cloud = o.cloud ?? new Cloud(); }

  /** Local tunnels opened from Studio (loopback only, through the authenticated SSH connection). Closed when Studio closes. */
  private readonly tunnels = new Map<number, { close(): void; app: string }>();
  closeTunnels(): void { for (const t of this.tunnels.values()) { try { t.close(); } catch { /* already closed */ } } this.tunnels.clear(); }
  private declarations() { return discoverDeclarations(this.root); }
  private env(name: string): { decl: DeploymentDecl; conn: string; pipeline: unknown; file: string } {
    const f = declFor(this.declarations(), name); const decl = JSON.parse(JSON.stringify(f.deployment.value)) as DeploymentDecl;
    return { decl, conn: decl.connection.credentials, pipeline: f.pipeline?.value, file: f.deployment.relative };
  }

  /** Local, never-remote facts: what is declared, which connections exist. Works even when remote management is disabled. */
  overview(): CloudResult {
    const decls = this.declarations();
    const environments = decls.filter((d) => d.kind === "deployment").map((d) => {
      const v = d.value as DeploymentDecl | undefined; const c = v ? this.cloud.store.connection(v.connection?.credentials) : undefined;
      return { environment: v?.environment ?? "?", name: v?.name ?? d.name, file: d.relative, connection: v?.connection?.credentials, connectionState: c ? (c.revoked ? "revoked" : c.clientId ? "enrolled" : c.agentFingerprint ? "agent installed, not enrolled" : "registered") : "missing", strategy: v?.strategy?.type, proxy: v?.strategy?.proxy ?? "none", pipeline: v?.pipeline, services: v ? servicesOf(v).map((s) => ({ name: s.name, runtime: s.runtime })) : [], source: v?.source ? (v.source.provider === "git" ? { provider: "git", url: v.source.url, ref: v.source.branch ?? v.source.tag ?? v.source.commit } : { provider: "artifact", path: v.source.path }) : undefined, problems: d.diagnostics.filter((x) => x.level === "error"), warnings: d.diagnostics.filter((x) => x.level === "warning") };
    });
    const pipelines = decls.filter((d) => d.kind === "pipeline").map((d) => ({ name: d.name, file: d.relative, stages: (d.value as { stages?: unknown[] } | undefined)?.stages ?? [], problems: d.diagnostics.filter((x) => x.level === "error"), warnings: d.diagnostics.filter((x) => x.level === "warning") }));
    let credentialStore: { id: string; available: boolean; reason?: string };
    try { credentialStore = { id: this.cloud.creds().id, available: true }; } catch (e) { credentialStore = { id: "none", available: false, reason: (e as Error).message }; }
    return ok({ remoteEnabled: this.enabled, environments, pipelines, connections: this.cloud.list(), signers: this.cloud.signers(), credentialStore, localAudit: this.cloud.store.verifyAudit() });
  }

  async get(path: string, q: URLSearchParams): Promise<CloudResult> {
    if (path === "/api/cloud/overview") return this.overview();
    if (!this.enabled) return fail(403, "Remote management is disabled. Start Studio with `pso studio --remote` to manage servers from here.", "REMOTE_DISABLED");
    try {
      if (path === "/api/cloud/hostkeys") { const host = q.get("host") ?? ""; const port = Number(q.get("port") ?? 22); return ok({ keys: this.cloud.hostKeys(host, port).map((k) => ({ type: k.type, fingerprint: k.fingerprint })) }); }
      if (path === "/api/cloud/local-audit") return ok({ entries: this.cloud.store.readAudit(200).reverse(), chain: this.cloud.store.verifyAudit() });
      const m = /^\/api\/cloud\/env\/([a-z][a-z0-9-]{0,30})\/([a-z-]+)(?:\/([A-Za-z0-9._-]+))?$/.exec(path);
      if (!m) return fail(404, "unknown endpoint");
      const [, envName, what, id] = m as unknown as [string, string, string, string | undefined];
      const e = this.env(envName); const app = e.decl.name;
      const call = <T>(op: string, args: unknown = {}): Promise<T> => this.cloud.with(e.conn, (c) => c.call<T>(op, args));
      switch (what) {
        case "status": { const [s, i] = await Promise.all([call<unknown>("release.status", { app }), call<unknown>("inspect")]); return ok({ status: s, inspection: i }); }
        case "inspect": return ok(await call("inspect"));
        case "provision-plan": return ok(await call("provision.plan"));
        case "policy": return ok(await call("policy.get"));
        case "policy-compat": return ok(await call("policy.compat"));
        case "history": return ok({ history: await call("release.history", { app, limit: 30 }), releases: await call("release.list", { app }) });
        case "deployment": return ok(await call("release.get", { app, deployment: id }));
        case "logs": return ok(await call("logs.read", { app, ...(q.get("deployment") ? { deployment: q.get("deployment") } : {}), ...(q.get("service") ? { service: q.get("service") } : {}) }));
        case "audit": return ok(q.get("verify") === "1" ? await call("audit.verify") : { entries: await call("audit.read", { limit: 200 }) });
        case "clients": return ok(await call("client.list"));
        // ---- operational visibility: the same facade calls as the CLI
        case "overview": return ok(await this.cloud.applicationOverview(e.conn, app));
        case "reachability": return ok(await this.cloud.reachability(e.conn, app, { tunnel: q.get("tunnel") === "1" }));
        case "endpoints": return ok(await this.cloud.endpoints(e.conn, app));
        case "runtime": return ok(await this.cloud.runtime(e.conn));
        case "exposure": return ok(await this.cloud.exposure(e.conn, { verifyFromClient: q.get("verify") === "1" }));
        case "privileges": return ok(await this.cloud.privileges(e.conn));
        case "appconfig": return ok(await this.cloud.appConfig(e.conn, app));
        case "nginx": return ok(await this.cloud.nginxView(e.conn));
        case "nginx-file": return ok(await this.cloud.nginxRead(e.conn, q.get("file") ?? ""));
        case "nginx-backups": return ok({ backups: await this.cloud.nginxBackups(e.conn, app) });
        case "trust": return ok(await call("trust.list"));
        case "secrets": return ok({ names: await call("secret.list") });
        case "declaration": { const f = declFor(this.declarations(), envName); return ok({ file: f.deployment.relative, deployment: f.deployment.value, pipeline: f.pipeline?.value, diagnostics: [...f.deployment.diagnostics, ...(f.pipeline?.diagnostics ?? [])] }); }
        default: return fail(404, "unknown endpoint");
      }
    } catch (e) { return this.err(e); }
  }

  async post(path: string, b: Record<string, unknown>): Promise<CloudResult> {
    if (!this.enabled) return fail(403, "Remote management is disabled. Start Studio with `pso studio --remote`.", "REMOTE_DISABLED");
    const s = (k: string): string => { const v = b[k]; if (typeof v !== "string" || !v) throw new CloudError(`${k} is required`, "BAD_REQUEST"); return v; };
    try {
      switch (path) {
        case "/api/cloud/connections": {
          const auth = (b["auth"] as "key" | "agent" | "password") ?? "agent";
          const rec = this.cloud.add({ name: s("name"), host: s("host"), user: s("user"), port: Number(b["port"] ?? 22), auth, ...(typeof b["keyPath"] === "string" && b["keyPath"] ? { keyPath: b["keyPath"] as string } : {}), ...(typeof b["passphrase"] === "string" && b["passphrase"] ? { passphrase: b["passphrase"] as string } : {}), ...(typeof b["password"] === "string" && b["password"] ? { password: b["password"] as string } : {}) }, s("acceptHostKey"));
          return ok({ name: rec.name, added: true, credentialStore: this.cloud.creds().id });
        }
        case "/api/cloud/connections/tls-ca": { this.cloud.setTlsCa(s("name"), typeof b["file"] === "string" && b["file"] ? (b["file"] as string) : undefined); return ok({ saved: true }); }
        case "/api/cloud/connections/key": return ok(this.cloud.keyAccess(s("name")));
        case "/api/cloud/connections/key-repair": { // never silent: the person must type the connection name; the response reports the rights as measured afterwards
          if (b["confirm"] !== s("name")) throw new CloudError(`type "${s("name")}" to confirm changing the access rights of its private key file`, "CONFIRM");
          return ok(this.cloud.repairKeyAccess(s("name"), { confirm: true }));
        }
        case "/api/cloud/connections/test": return ok(await this.cloud.test(s("name"), typeof b["pinAgent"] === "string" ? { pinAgent: b["pinAgent"] as string } : {}));
        case "/api/cloud/connections/rotate": { if (b["kind"] === "ssh-secret") { this.cloud.rotateSshSecret(s("name"), s("value")); return ok({ rotated: "ssh-secret" }); } return ok(await this.cloud.rotateClientKey(s("name"))); }
        case "/api/cloud/connections/revoke": return ok(await this.cloud.revoke(s("name")));
        case "/api/cloud/connections/remove": return ok(this.cloud.remove(s("name")));
        case "/api/cloud/agent/install": return ok(await this.cloud.installAgent(s("name"), { mode: s("mode") as "development" | "protected", environment: s("environment"), yes: true }));
        case "/api/cloud/agent/enroll": return ok(await this.cloud.enroll(s("name"), s("token")));
        // signing identities of THIS machine: the private key goes to the protected credential store and is never returned
        case "/api/cloud/signers": { if (b["remove"] === true) return ok(this.cloud.signerRemove(s("name"))); return ok(this.cloud.signerGenerate(s("name"))); }
      }
      const m = /^\/api\/cloud\/env\/([a-z][a-z0-9-]{0,30})\/([a-z-]+)$/.exec(path);
      if (!m) return fail(404, "unknown endpoint");
      const e = this.env(m[1]!); const app = e.decl.name; const what = m[2]!;
      const call = <T>(op: string, args: unknown = {}): Promise<T> => this.cloud.with(e.conn, (c) => c.call<T>(op, args));
      const confirmed = (): void => { if (b["confirm"] !== e.decl.environment && b["confirm"] !== app) throw new CloudError(`type "${app}" (or its environment name "${e.decl.environment}") to confirm`, "CONFIRM"); };
      switch (what) {
        case "plan": {
          const decl = this.withRef(e.decl, b); const plan = await this.cloud.plan(e.conn, decl, e.pipeline as never, this.root, typeof b["signedFile"] === "string" && b["signedFile"] ? this.readSigned(b["signedFile"] as string) : undefined);
          return ok(plan as Plan);
        }
        case "approve": return ok(await this.cloud.approve(e.conn, app, s("planHash")));
        case "deploy": { confirmed(); const d = await this.cloud.start(e.conn, app, s("planHash")); return ok(d); }
        case "cancel": confirmed(); return ok(await call("release.cancel", { app, deployment: s("deployment") }));
        case "rollback": { confirmed(); const d = await call<unknown>("release.rollback", { app, ...(typeof b["to"] === "string" ? { to: b["to"] } : {}) }); this.cloud.store.audit("release.rollback", { connection: e.conn, app }); return ok(d); }
        case "recover": confirmed(); return ok(await call("release.recover", { app }));
        case "service": { confirmed(); const act = s("action"); if (!["restart", "start", "stop"].includes(act)) throw new CloudError("invalid action", "BAD_REQUEST"); const r = await call<unknown>(`service.${act}`, { app, service: s("service") }); this.cloud.store.audit(`service.${act}`, { connection: e.conn, service: b["service"] }); return ok(r); }
        case "trust-add": { confirmed(); const apps = typeof b["apps"] === "string" && b["apps"].trim() ? (b["apps"] as string).split(",").map((x) => x.trim()) : undefined; return ok(await this.cloud.trustAdd(e.conn, { signer: s("signer"), ...(apps ? { apps } : {}), ...(typeof b["notAfter"] === "string" && b["notAfter"] ? { notAfter: b["notAfter"] as string } : {}) })); }
        case "trust-revoke": confirmed(); return ok(await this.cloud.trustRevoke(e.conn, s("keyId"), typeof b["reason"] === "string" ? (b["reason"] as string) : undefined));
        case "policy-set": { confirmed(); const ch = b["changes"]; if (!ch || typeof ch !== "object") throw new CloudError("changes is required", "BAD_REQUEST"); const r = await call<{ changed: unknown }>("policy.set", { changes: ch }); this.cloud.store.audit("policy.changed", { connection: e.conn, changed: r.changed }); return ok(r); }
        case "sign": {
          confirmed();
          const seq = Number(b["sequence"]); const path = this.inside(typeof b["path"] === "string" && b["path"] ? (b["path"] as string) : ".");
          const manifest = this.cloud.buildManifest({ app, path, sequence: seq, ...(e.decl.source.provider === "git" ? { url: e.decl.source.url } : {}) });
          const signed = this.cloud.signRelease(s("signer"), manifest); const file = resolve(this.root, `${app}.release.signed.json`); writeFileSync(file, JSON.stringify(signed, null, 2));
          return ok({ file: relative(this.root, file).replace(/\\/g, "/"), keyId: signed.signatures[0]!.keyId, sequence: manifest.sequence, source: manifest.source });
        }
        case "verify": { const sg = this.readSigned(s("signedFile")); const m = JSON.parse(sg.manifest) as { app: string; source: { kind: "git"; commit: string } | { kind: "artifact"; sha256: string } }; return ok(await this.cloud.verifyOnServer(e.conn, m.app, sg, m.source)); }
        case "request": { // ONE request to the application's own URL: explicit action, strict TLS, mutating methods need their own confirmation
          const method = typeof b["method"] === "string" ? (b["method"] as string).toUpperCase() : "GET"; const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
          if (mutating && b["confirmMutating"] !== true) throw new CloudError(`${method} changes state: tick the confirmation to send it`, "CONFIRM");
          const req = { method, path: s("path"), ...(b["query"] && typeof b["query"] === "object" ? { query: b["query"] as Record<string, string> } : {}), ...(b["headers"] && typeof b["headers"] === "object" ? { headers: b["headers"] as Record<string, string> } : {}), ...(b["body"] !== undefined && b["body"] !== "" ? { body: b["body"] } : {}), ...(typeof b["token"] === "string" && b["token"] ? { token: b["token"] as string } : {}) };
          return ok(await this.cloud.testRequest(e.conn, app, req, { ...(typeof b["urlIndex"] === "number" ? { urlIndex: b["urlIndex"] as number } : {}), confirmMutating: mutating, viaTunnel: b["viaTunnel"] === true }));
        }
        case "nginx-validate": return ok({ problems: this.cloud.nginxLint(typeof b["content"] === "string" ? (b["content"] as string) : "") });
        case "nginx-apply": { confirmed(); const action = s("action"); if (!["edit", "enable", "disable", "restore"].includes(action)) throw new CloudError("invalid action", "BAD_REQUEST"); return ok(await this.cloud.nginxApply(e.conn, { file: s("file"), action: action as "edit", ...(typeof b["content"] === "string" ? { content: b["content"] as string } : {}), ...(typeof b["expectedHash"] === "string" ? { expectedHash: b["expectedHash"] as string } : {}), ...(typeof b["backupId"] === "string" ? { backupId: b["backupId"] as string } : {}) })); }
        case "open-tunnel": { // a private (loopback) address of the application, reached through the authenticated SSH connection; never bound publicly
          const ov = await this.cloud.applicationOverview(e.conn, app); const u = (ov.resolvedUrls as Array<{ visibility: string; port: number; scheme: string; path: string }>)[Number(b["urlIndex"] ?? 0)];
          if (!u || u.visibility !== "private" || u.scheme !== "http") throw new CloudError("only a private http address of this application can be opened through a tunnel from here", "BAD_REQUEST");
          const local = 20000 + Math.floor(Math.random() * 20000); const t = this.cloud.tunnel(e.conn, local, u.port); this.tunnels.set(local, { close: () => t.close(), app });
          await new Promise((r) => setTimeout(r, 2000)); return ok({ url: `http://127.0.0.1:${local}${u.path === "/" ? "/" : u.path}`, note: "loopback only; closed when Studio closes" });
        }
        case "provision-apply": confirmed(); return ok(await call("provision.apply"));
        case "secret": { confirmed(); if (b["remove"] === true) { await call("secret.remove", { name: s("name") }); return ok({ removed: true }); } await call("secret.set", { name: s("name"), value: s("value") }); this.cloud.store.audit("secret.set", { connection: e.conn, name: b["name"] }); return ok({ stored: true }); }
        case "invite": { confirmed(); const t = await call<unknown>("enroll.create", { role: s("role"), minutes: Number(b["minutes"] ?? 15) }); return { status: 200, body: t }; }
        case "revoke-client": confirmed(); return ok(await call("client.revoke", { clientId: s("clientId") }));
        default: return fail(404, "unknown endpoint");
      }
    } catch (e) { return this.err(e); }
  }

  /** A path from the browser is only ever read or written INSIDE the workspace. */
  private inside(p: string): string { const full = resolve(this.root, p); const rel = relative(this.root, full); if (rel.startsWith("..") || isAbsolute(rel)) throw new CloudError("that path is outside the workspace", "BAD_REQUEST"); return full; }
  private readSigned(file: string): import("@pso/deploy").SignedManifest { try { return JSON.parse(readFileSync(this.inside(file), "utf8")) as import("@pso/deploy").SignedManifest; } catch (e) { if (e instanceof CloudError) throw e; throw new CloudError(`cannot read the signed manifest ${file}`, "BAD_REQUEST"); } }

  private withRef(decl: DeploymentDecl, b: Record<string, unknown>): DeploymentDecl {
    const d = JSON.parse(JSON.stringify(decl)) as DeploymentDecl;
    if (d.source.provider === "git" && (b["branch"] || b["tag"] || b["commit"])) {
      delete d.source.branch; delete d.source.tag; delete d.source.commit;
      if (typeof b["commit"] === "string" && b["commit"]) d.source.commit = b["commit"]; else if (typeof b["tag"] === "string" && b["tag"]) d.source.tag = b["tag"]; else if (typeof b["branch"] === "string") d.source.branch = b["branch"];
    }
    return d;
  }

  private err(e: unknown): CloudResult {
    if (e instanceof CloudError) return fail(e.code === "FORBIDDEN" ? 403 : e.code === "NOT_FOUND" ? 404 : 422, e.message, e.code, e.hint);
    if (e instanceof Error) return fail(500, e.message, "ERROR");
    return fail(500, "unexpected error");
  }
}
