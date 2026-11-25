import { CONTEXT_CONTRACT_VERSION } from "./contracts.ts";
import { contractCompatible, satisfies, isSafeAppPath } from "./validate.ts";

/**
 * What a published MEI release is, as data. A MEI release is a directory of immutable, content-hashed files plus this manifest. The
 * FEI loads a MEI only through its manifest: the manifest names the files, their hashes, the context contract and the shared
 * dependencies the MEI was built with, so an incompatible or tampered release is refused BEFORE its code runs.
 */
export interface RemoteFile { path: string; sha256: string; size: number }
export interface RemoteManifest {
  schema: 1;
  kind: "pso-mei-manifest";
  name: string;
  host: string;
  version: string;
  contract: { context: string };
  /** the federation entry, relative to the manifest's directory */
  entry: string;
  /** the module the MEI exposes to the host */
  expose: string;
  shared: Record<string, string>;
  scopes: string[];
  /** effective routes, for navigation and prefetch decisions */
  routes: Array<{ path: string; title?: string | Record<string, string> }>;
  files: RemoteFile[];
  createdAt: string;
  /** detached signature over `canonicalManifest(manifest without signature)` */
  signature?: { keyId: string; alg: "ed25519"; value: string };
}

/** What the deployment publishes next to the FEI (never built into the bundle): where each approved remote's manifest is. */
export interface FrontendRuntimeConfig {
  schema: 1;
  fei: string;
  version?: string;
  mode: "production" | "development";
  orchestrator: { basePath: string; channelsPath?: string };
  /** production: `manifest` (same-origin `/_mei/<name>/pso-manifest.json`). development only: `devEntry`, the federation entry of a local dev server */
  remotes: Record<string, { manifest?: string; devEntry?: string; version?: string }>;
  /** ed25519 public keys (base64url raw) the remote manifests must be signed with; empty in development */
  trustedKeys?: Array<{ keyId: string; publicKey: string }>;
  requireSignature?: boolean;
  auth?: { kind: "oidc"; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; scope?: string; redirectPath?: string; logoutEndpoint?: string; postLogoutRedirectPath?: string; restoreSession?: boolean } | { kind: "dev-token" } | { kind: "none" };
}

export function canonicalManifest(m: Omit<RemoteManifest, "signature"> | RemoteManifest): string {
  const { signature: _s, ...rest } = m as RemoteManifest;
  void _s;
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(rest));
}

const FILE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._~\-/]+$/;
export function parseManifest(raw: unknown): { manifest?: RemoteManifest; problems: string[] } {
  const p: string[] = [];
  const o = raw as Partial<RemoteManifest> | null;
  if (!o || typeof o !== "object") return { problems: ["the manifest is not an object"] };
  if (o.schema !== 1 || o.kind !== "pso-mei-manifest") p.push("not a PSO MEI manifest (schema 1)");
  for (const k of ["name", "host", "version", "entry", "expose", "createdAt"] as const) if (typeof o[k] !== "string" || !o[k]) p.push(`"${k}" is missing`);
  if (!/^mei-[a-z0-9-]+$/.test(String(o.name))) p.push(`"name" is not a valid MEI name`);
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(String(o.version))) p.push(`"version" is not a semantic version`);
  if (typeof o.entry === "string" && !FILE.test(o.entry)) p.push(`"entry" must be a relative file inside the release`);
  if (!o.contract || typeof o.contract.context !== "string") p.push(`"contract.context" is missing`);
  if (!Array.isArray(o.files) || o.files.length === 0) p.push(`"files" must list the release files with their hashes`);
  else for (const f of o.files) if (!f || typeof f.path !== "string" || !FILE.test(f.path) || !/^[0-9a-f]{64}$/.test(String(f.sha256)) || typeof f.size !== "number") { p.push(`invalid file entry ${JSON.stringify(f)?.slice(0, 80)}`); break; }
  if (Array.isArray(o.files) && typeof o.entry === "string" && !o.files.some((f) => f.path === o.entry)) p.push(`"entry" (${o.entry}) is not listed in "files": its integrity could not be verified`);
  if (!o.shared || typeof o.shared !== "object") p.push(`"shared" is missing`);
  if (!Array.isArray(o.routes)) p.push(`"routes" is missing`); else for (const r of o.routes) if (!isSafeAppPath(r?.path)) { p.push(`route path ${JSON.stringify(r?.path)} is invalid`); break; }
  return p.length ? { problems: p } : { manifest: o as RemoteManifest, problems: [] };
}

export interface HostCapabilities { contract: string; shared: Record<string, string> }

/** Everything the FEI checks before it loads a remote: name, host, contract and shared singletons. Returns human-readable reasons. */
export function checkRemoteCompatibility(m: RemoteManifest, expected: { name: string; host: string }, host: HostCapabilities = { contract: CONTEXT_CONTRACT_VERSION, shared: {} }): string[] {
  const out: string[] = [];
  if (m.name !== expected.name) out.push(`the manifest is for "${m.name}", expected "${expected.name}"`);
  if (m.host !== expected.host) out.push(`"${m.name}" ${m.version} was built for host "${m.host}", not "${expected.host}"`);
  const c = contractCompatible(m.contract.context, host.contract);
  if (!c.ok) out.push(c.reason);
  for (const [dep, mine] of Object.entries(m.shared)) {
    const have = host.shared[dep];
    // the manifest records the version the MEI was built with; a singleton is shared when the major is the same and the host is not older
    const range = /^\d/.test(mine) ? `^${mine}` : mine;
    if (have !== undefined && !satisfies(have, range)) out.push(`shared dependency "${dep}": the MEI needs ${range} but the host provides ${have}`);
  }
  return out;
}

/** A remote location is trusted only when it is same-origin under the remote prefix, or on an origin the runtime config explicitly lists. */
export function isTrustedRemoteUrl(url: string, opts: { origin: string; mode: "production" | "development"; allowedOrigins?: readonly string[] }): boolean {
  let u: URL;
  try { u = new URL(url, opts.origin); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.origin === opts.origin) return opts.mode === "development" || u.pathname.startsWith("/_mei/") || u.pathname.startsWith(new URL(opts.origin).pathname.replace(/\/$/, "") + "/_mei/");
  if (opts.mode === "development") return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && u.protocol === "http:";
  return u.protocol === "https:" && (opts.allowedOrigins ?? []).includes(u.origin);
}

// ---- browser-safe cryptography (WebCrypto only) -------------------------------------------------------------------------------

const subtle = (): SubtleCrypto => {
  const s = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this context (a secure context is required)");
  return s;
};
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const b64u = {
  encode: (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string): Uint8Array<ArrayBuffer> => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(new ArrayBuffer(bin.length)); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
};
export async function sha256Hex(data: BufferSource): Promise<string> { return hex(await subtle().digest("SHA-256", data)); }
/** `sha256-<base64>` as used by the Subresource Integrity attribute, from the hex digest the manifest holds. */
export const sriFromHex = (h: string): string => `sha256-${btoa(String.fromCharCode(...(h.match(/../g) ?? []).map((x) => parseInt(x, 16))))}`;

export async function verifyManifestSignature(m: RemoteManifest, keys: ReadonlyArray<{ keyId: string; publicKey: string }>): Promise<{ ok: true; keyId: string } | { ok: false; reason: string }> {
  if (!m.signature) return { ok: false, reason: "the manifest is not signed" };
  if (m.signature.alg !== "ed25519") return { ok: false, reason: `unsupported signature algorithm "${m.signature.alg}"` };
  const key = keys.find((k) => k.keyId === m.signature!.keyId);
  if (!key) return { ok: false, reason: `the manifest is signed with key "${m.signature.keyId}", which is not trusted by this application` };
  try {
    const pub = await subtle().importKey("raw", b64u.decode(key.publicKey), { name: "Ed25519" }, false, ["verify"]);
    const ok = await subtle().verify({ name: "Ed25519" }, pub, b64u.decode(m.signature.value), new TextEncoder().encode(canonicalManifest(m)));
    return ok ? { ok: true, keyId: key.keyId } : { ok: false, reason: "the signature does not match the manifest" };
  } catch (e) { return { ok: false, reason: `signature verification failed: ${(e as Error).message}` }; }
}
