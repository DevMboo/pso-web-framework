import {
  CONTEXT_CONTRACT_VERSION, checkRemoteCompatibility, contractCompatible, isTrustedRemoteUrl, parseManifest, sha256Hex, sriFromHex, verifyManifestSignature,
  type FrontendRuntimeConfig, type MeiModuleExport, type RemoteManifest,
} from "@pso/frontend";

/**
 * Loads a MEI. The FEI never loads a script URL it was merely handed: the location comes from the runtime configuration the
 * deployment published, the manifest is validated (shape, host, contract, shared versions, signature), and the browser enforces the
 * hash of every script chunk the manifest lists through Subresource Integrity.
 */
export type RemoteFailureKind = "not-registered" | "untrusted" | "manifest-unavailable" | "manifest-invalid" | "incompatible" | "signature" | "load-failed" | "timeout" | "bad-module";
export class RemoteLoadError extends Error {
  readonly kind: RemoteFailureKind;
  readonly remote: string;
  readonly reasons: string[];
  constructor(kind: RemoteFailureKind, remote: string, message: string, reasons: string[] = []) { super(message); this.name = "RemoteLoadError"; this.kind = kind; this.remote = remote; this.reasons = reasons; }
}

/** The part of the Module Federation runtime used here; injectable so the logic is testable without a browser. */
export interface FederationRuntime {
  registerRemotes(remotes: Array<{ name: string; entry: string }>, o?: { force?: boolean }): void;
  loadRemote<T>(id: string): Promise<T | null | undefined>;
  /** the federation runtime's plugin hook: used to put Subresource Integrity on every script a manifest listed */
  registerPlugins?(plugins: unknown[]): void;
}
export interface LoaderOptions {
  config: FrontendRuntimeConfig;
  origin: string;
  federation: FederationRuntime;
  /** versions of the shared singletons the host provides */
  hostShared?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** attempts after the first one; each waits with backoff (default 1) */
  retries?: number;
  now?: () => number;
}
export interface RemoteStatus { name: string; state: "idle" | "loading" | "ready" | "failed"; version?: string; error?: RemoteLoadError; routes?: RemoteManifest["routes"] }

const ident = (n: string): string => n.replace(/[^A-Za-z0-9_]/g, "_");

export function createRemoteLoader(o: LoaderOptions) {
  const timeout = o.timeoutMs ?? 15_000;
  const retries = Math.min(o.retries ?? 1, 3);
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const modules = new Map<string, MeiModuleExport>();
  const pending = new Map<string, Promise<MeiModuleExport>>();
  const status = new Map<string, RemoteStatus>();
  const subs = new Set<() => void>();
  const sri = new Map<string, string>(); // absolute URL -> integrity of every file of every approved release
  const registered = new Map<string, string>(); // remote -> entry already registered
  let pluginHooked = false;
  const trusted = (u: string) => isTrustedRemoteUrl(u, { origin: o.origin, mode: o.config.mode, allowedOrigins: [] });

  const set = (name: string, s: Partial<RemoteStatus>) => { status.set(name, { ...(status.get(name) ?? { name, state: "idle" }), ...s, name }); for (const f of [...subs]) f(); };

  /** Reads one JSON document; `what` names it in the messages. */
  async function getText(name: string, url: string, signal: AbortSignal, what: string): Promise<string> {
    let res: Response;
    try { res = await doFetch(url, { cache: "no-store", credentials: "omit", redirect: "error", signal, referrerPolicy: "no-referrer", headers: { accept: "application/json" } }); }
    catch (e) { throw new RemoteLoadError("manifest-unavailable", name, `the ${what} of "${name}" could not be fetched (${(e as Error).message})`); }
    if (!res.ok) throw new RemoteLoadError("manifest-unavailable", name, `the ${what} of "${name}" answered HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 512 * 1024) throw new RemoteLoadError("manifest-invalid", name, `the ${what} of "${name}" is unreasonably large`);
    return text;
  }

  /**
   * The remote's location in the runtime configuration is either a manifest or a POINTER to the active release. The pointer is a tiny,
   * never-cached file the deployment rewrites atomically; the manifest it names is immutable and signed, and the pointer records its hash.
   */
  async function fetchManifest(name: string, url: string, signal: AbortSignal): Promise<{ manifest: RemoteManifest; url: string }> {
    let text = await getText(name, url, signal, "release information");
    let json: unknown; try { json = JSON.parse(text); } catch { throw new RemoteLoadError("manifest-invalid", name, `the release information of "${name}" is not JSON`); }
    let at = url;
    const ptr = json as { kind?: string; manifest?: string; manifestSha256?: string; name?: string };
    if (ptr?.kind === "pso-mei-pointer") {
      if (ptr.name !== name || typeof ptr.manifest !== "string" || !/^v\/\d+\.\d+\.\d+[0-9A-Za-z.+-]*\/pso-manifest\.json$/.test(ptr.manifest) || !/^[0-9a-f]{64}$/.test(String(ptr.manifestSha256))) throw new RemoteLoadError("manifest-invalid", name, `the release pointer of "${name}" is invalid`);
      at = new URL(ptr.manifest, url).href;
      if (!trusted(at)) throw new RemoteLoadError("untrusted", name, `the release the pointer of "${name}" names is not at an approved location`, [at]);
      text = await getText(name, at, signal, "manifest");
      if ((await sha256Hex(new TextEncoder().encode(text))) !== ptr.manifestSha256) throw new RemoteLoadError("manifest-invalid", name, `the manifest of "${name}" does not match the hash its pointer records (a release changed after it was activated, or the pointer and the files are from different releases)`);
      try { json = JSON.parse(text); } catch { throw new RemoteLoadError("manifest-invalid", name, `the manifest of "${name}" is not JSON`); }
    }
    const p = parseManifest(json);
    if (!p.manifest) throw new RemoteLoadError("manifest-invalid", name, `the manifest of "${name}" is invalid`, p.problems);
    return { manifest: p.manifest, url: at };
  }

  function hookIntegrity(): void { pluginHooked = true; }
  /** The integrity attribute for a script URL, if a manifest listed it. Used by the federation runtime plugin below. */
  const integrityFor = (url: string): string | undefined => sri.get(url);

  async function loadOnce(name: string, signal: AbortSignal): Promise<MeiModuleExport> {
    const remote = o.config.remotes[name];
    if (!remote) throw new RemoteLoadError("not-registered", name, `"${name}" is not registered in the runtime configuration of this application`);
    let entry: string, manifest: RemoteManifest | undefined;
    if (remote.manifest) {
      const url = new URL(remote.manifest, o.origin).href;
      if (!trusted(url)) throw new RemoteLoadError("untrusted", name, `the manifest location of "${name}" is not an approved remote location`, [url]);
      const fetched = await fetchManifest(name, url, signal);
      manifest = fetched.manifest;
      const manifestUrl = fetched.url;
      const issues = checkRemoteCompatibility(manifest, { name, host: o.config.fei }, { contract: CONTEXT_CONTRACT_VERSION, shared: o.hostShared ?? {} });
      if (issues.length) throw new RemoteLoadError("incompatible", name, `"${name}" ${manifest.version} cannot run in this application`, issues);
      // required: unsigned or untrusted manifests are refused. Not required: a signature that is present AND checkable must still verify
      if (o.config.requireSignature || (manifest.signature && o.config.trustedKeys?.length)) {
        const v = await verifyManifestSignature(manifest, o.config.trustedKeys ?? []);
        if (!v.ok) throw new RemoteLoadError("signature", name, `the manifest of "${name}" was refused: ${v.reason}`);
      }
      entry = new URL(manifest.entry, manifestUrl).href;
      if (!trusted(entry)) throw new RemoteLoadError("untrusted", name, `the entry of "${name}" is not an approved remote location`, [entry]);
      for (const f of manifest.files) { const fu = new URL(f.path, manifestUrl).href; if (trusted(fu)) sri.set(fu, sriFromHex(f.sha256)); }
    } else if (o.config.mode === "development" && remote.devEntry) {
      entry = remote.devEntry;
      if (!trusted(entry)) throw new RemoteLoadError("untrusted", name, `development entry of "${name}" is not a local address`, [entry]);
    } else throw new RemoteLoadError("not-registered", name, `"${name}" has no manifest in the runtime configuration`);

    if (registered.get(name) !== entry) { o.federation.registerRemotes([{ name: ident(name), entry }], { force: true }); registered.set(name, entry); }
    hookIntegrity();
    let mod: unknown;
    try { mod = (await o.federation.loadRemote<{ default?: unknown }>(`${ident(name)}/module`))?.default ?? undefined; }
    catch (e) { throw new RemoteLoadError("load-failed", name, `the code of "${name}" could not be loaded (${(e as Error).message})`); }
    const m = mod as Partial<MeiModuleExport> | undefined;
    if (!m || m.kind !== "pso-mei-module" || m.name !== name || typeof m.contract !== "string" || !m.Root) throw new RemoteLoadError("bad-module", name, `"${name}" did not export a PSO MEI module (createMeiModule)`);
    const c = contractCompatible(m.contract);
    if (!c.ok) throw new RemoteLoadError("incompatible", name, `"${name}" ${c.reason}`);
    set(name, { state: "ready", ...(manifest ? { version: manifest.version, routes: manifest.routes } : {}) });
    return m as MeiModuleExport;
  }

  async function load(name: string, o2: { force?: boolean } = {}): Promise<MeiModuleExport> {
    const cached = modules.get(name);
    if (cached && !o2.force) return cached;
    const running = pending.get(name);
    if (running) return running;
    set(name, { state: "loading" });
    const p = (async () => {
      let last: RemoteLoadError | undefined;
      for (let n = 0; n <= retries; n++) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeout);
        try {
          const m = await Promise.race([loadOnce(name, ctl.signal), new Promise<never>((_, rej) => { ctl.signal.addEventListener("abort", () => rej(new RemoteLoadError("timeout", name, `"${name}" did not load within ${Math.round(timeout / 1000)} s`)), { once: true }); })]);
          modules.set(name, m);
          return m;
        } catch (e) {
          last = e instanceof RemoteLoadError ? e : new RemoteLoadError("load-failed", name, (e as Error).message);
          // configuration, trust, compatibility and signature problems do not fix themselves: no retry
          if (!["manifest-unavailable", "load-failed", "timeout"].includes(last.kind) || n === retries) break;
          await new Promise((r) => setTimeout(r, 300 * 2 ** n));
        } finally { clearTimeout(t); }
      }
      set(name, { state: "failed", error: last! });
      throw last!;
    })().finally(() => { pending.delete(name); });
    pending.set(name, p);
    return p;
  }

  const plugin = { name: "pso-integrity", createScript: ({ url }: { url: string }) => { const s = document.createElement("script"); s.src = url; s.async = true; const i = sri.get(url); if (i) s.integrity = i; s.crossOrigin = "anonymous"; return s; } };
  o.federation.registerPlugins?.([plugin]);

  return {
    load,
    /** warm the cache without rendering: manifest and code. Refused on constrained networks and for unknown remotes */
    async prefetch(name: string): Promise<boolean> {
      const conn = (globalThis as { navigator?: { connection?: { saveData?: boolean; effectiveType?: string } } }).navigator?.connection;
      if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? "")) return false;
      if (!o.config.remotes[name] || modules.has(name) || pending.has(name)) return false;
      try { await load(name); return true; } catch { return false; }
    },
    status: (name: string): RemoteStatus => status.get(name) ?? { name, state: "idle" },
    subscribe(cb: () => void) { subs.add(cb); return () => { subs.delete(cb); }; },
    integrityFor,
    isHooked: () => pluginHooked,
    /** the federation runtime plugin that sets `integrity` on every script the manifest listed (pass it to the runtime's plugin list) */
    runtimePlugin: () => plugin,
    forget(name: string) { modules.delete(name); },
  };
}
export type RemoteLoader = ReturnType<typeof createRemoteLoader>;
