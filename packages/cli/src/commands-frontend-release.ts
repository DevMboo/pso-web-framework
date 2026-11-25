import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FrontendDecl, WorkspaceConfig } from "@pso/core";
import { formatDiagnostic } from "@pso/core";
import {
  FEI_FILE, ReleaseRefused, activeFei, activePointer, history, loadFrontends, renderSiteServer, publicKeyRaw, publishFei, publishMei, readRuntimeConfig, rollbackMei, versions, feiOf,
  writeRuntimeConfig, validateEcosystem,
} from "@pso/frontend/node";
import type { Command, Ctx } from "./commands.ts";
import { emit, reportWrites, requireWorkspace, saveWorkspace } from "./commands.ts";
import { validateDeployment } from "@pso/deploy";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { CONTRACT_FILE, buildContract, contractVersionOf, diffContracts, renderContractTs, type OrchestratorContract } from "./frontend-contracts.ts";
import { writeFileSync as write } from "node:fs";
import { paths, plan } from "@pso/infra";
import { INFRA_HOOKS, engine } from "./commands-infra.ts";
import { trustedKeyOfSigner } from "./frontend-signing.ts";

/** Frontend releases: publish, roll back, inspect, runtime configuration, nginx layout and typed contracts. */
const frontends = (c: WorkspaceConfig): FrontendDecl[] => c.frontends ?? [];
const nameFor = (raw: string, kind?: "fei" | "mei"): string[] => (raw.startsWith("fei-") || raw.startsWith("mei-") ? [raw] : kind ? [`${kind}-${raw}`] : [`fei-${raw}`, `mei-${raw}`]);

function pick(config: WorkspaceConfig, raw: string | undefined, what = "project"): FrontendDecl {
  if (!raw) throw new CliError(`Missing ${what} name`, `Known: ${frontends(config).map((f) => f.name).join(", ") || "(none)"}`);
  const f = frontends(config).find((x) => nameFor(raw).includes(x.name));
  if (!f) throw new CliError(`Unknown frontend project "${raw}"`, `Known: ${frontends(config).map((f2) => f2.name).join(", ") || "(none)"}`);
  return f;
}
/**
 * The site root a command works on: --site, or (0.2.0) --env, where the infrastructure contract decides: every FEI has its own site
 * (.infra/sites/<env>/<fei>) and a MEI is always published into the site of the shell it is built for, never into another one.
 */
export function siteFor(ctx: Ctx, project?: string): { site: string; basePath?: string; fei?: string } {
  const s = str(ctx.flags["site"]), env = str(ctx.flags["env"]);
  if (s && env) throw new CliError("--site and --env both choose the site root: use one");
  if (env) {
    const { root } = requireWorkspace(ctx);
    const p = engine(() => plan(root, env, INFRA_HOOKS));
    const { config } = requireWorkspace(ctx);
    const loaded = loadFrontends(root, frontends(config));
    const shell = project ? feiOf(loaded, project) : loaded.feis.length === 1 ? loaded.feis[0] : undefined;
    if (!shell) throw new CliError(project ? `${project} is not hosted by a FEI of this workspace` : "Several FEIs: name the project", "pso frontend:inspect");
    const f = p.topology.frontends.find((x) => x.name === shell.definition.name)!;
    return { site: join(root, ...paths.site(p.environment, f.name).split("/")), basePath: f.basePath, fei: f.name };
  }
  if (!s) throw new CliError("--site <directory> or --env <name> is required", "The site root is the directory your web server serves (see `pso frontend:nginx`); with pso.infra.json, --env publishes into that environment's site of the right FEI");
  return { site: resolve(ctx.cwd, s) };
}
function siteOf(ctx: Ctx, project?: string): string {
  return siteFor(ctx, project).site;
}
/** The site root as the SERVER sees it (a POSIX path, used only to print a configuration): never resolved against this machine's file system. */
function sitePath(ctx: Ctx): string {
  const s = str(ctx.flags["site"]);
  if (!s) throw new CliError("--site <path on the server> is required", "For example --site /srv/pso/sites/shop");
  if (!/^\/[A-Za-z0-9_.\/-]{1,200}$/.test(s) || s.split("/").includes("..")) throw new CliError(`--site "${s}" must be an absolute POSIX path on the server without ".." segments`);
  return s.replace(/\/+$/, "");
}
const refuse = (e: unknown): never => {
  if (e instanceof ReleaseRefused) throw new CliError(e.message, e.reasons.length ? e.reasons.map((r) => `- ${r}`).join("\n") : undefined);
  throw e;
};
const versionOf = (dir: string, flag: string | undefined): string => flag ?? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;

export const FRONTEND_RELEASE_COMMANDS: Record<string, Command> = {
  "frontend:publish": {
    usage: "pso frontend:publish <project> --site <dir> | --env <name> [--version 1.2.0] [--base-path /commerce/] [--stage] [--json] | --all --env <name> [--json]",
    summary: "Publish a built FEI or MEI release to a site root: immutable versioned files, compatibility and integrity checks, then one atomic activation (nothing already published is overwritten or deleted)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (ctx.flags["all"] === true) {
        // every built project of the workspace, each into the site of its own shell: shells first, then the microfrontends
        if (ctx.positionals[0] || !str(ctx.flags["env"])) throw new CliError("--all publishes every project with --env <name>, without a project name");
        const order = [...frontends(config).filter((x) => x.kind === "fei"), ...frontends(config).filter((x) => x.kind === "mei")];
        let worst = 0;
        for (const x of order) { const code = FRONTEND_RELEASE_COMMANDS["frontend:publish"]!.run({ ...ctx, positionals: [x.name], flags: Object.fromEntries(Object.entries(ctx.flags).filter(([k]) => k !== "all")) }) as number; worst = Math.max(worst, code); }
        return worst;
      }
      const f = pick(config, ctx.positionals[0]);
      const target = siteFor(ctx, f.name);
      const site = target.site;
      if (target.fei) ctx.print(`site: ${site} (${f.kind === "mei" ? `the site of ${target.fei}, the shell ${f.name} is built for` : f.name})`);
      const dir = resolve(root, ...f.path.split("/"));
      const dist = join(dir, "dist");
      if (!existsSync(dist)) throw new CliError(`${f.name} has no dist/`, `Build it first: pso frontend:build ${f.name}`);
      const version = versionOf(dir, str(ctx.flags["version"]));
      mkdirSync(site, { recursive: true });
      try {
        if (f.kind === "fei") {
          const loaded = loadFrontends(root, frontends(config));
          if (!feiOf(loaded, f.name)) throw new CliError(`${FEI_FILE} of ${f.name} is invalid`, "pso frontend:validate");
          const basePath = str(ctx.flags["base-path"]) ?? target.basePath ?? "/";
          if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(basePath)) throw new CliError(`Invalid --base-path "${basePath}"`, "Use an absolute path ending in /, the one the FEI was built with");
          const html = readFileSync(join(dist, "index.html"), "utf8");
          if (basePath !== "/" && !html.includes(`<base href="${basePath}"`)) throw new CliError(`The build of ${f.name} was not made for base path ${basePath}`, `Rebuild with: pso frontend:build ${f.name} --base-path ${basePath}`);
          if (basePath === "/" && /<base href=/.test(html)) throw new CliError(`The build of ${f.name} has a base path but --base-path is "/"`, "Pass the base path the FEI was built with");
          const rel = publishFei({ site, dist, by: process.env["USERNAME"] ?? process.env["USER"] ?? "unknown" });
          if (rel.basePath !== basePath) throw new CliError(`The FEI was built for base path ${rel.basePath}, not ${basePath}`, "Pass the base path the FEI was built with, or rebuild");
          const cfg = readRuntimeConfig(site);
          emit(ctx, { published: rel.name, version, activated: true, runtimeConfig: cfg !== undefined }, `${rel.name} ${version} is active (${rel.files.length} files, host contract ${rel.contract})${cfg ? "" : "\nnote: this site has no pso-runtime-config.json yet: run `pso frontend:config --site ...` before opening the application"}`);
          return 0;
        }
        const r = publishMei({ site, dist, stage: ctx.flags["stage"] === true, by: process.env["USERNAME"] ?? process.env["USER"] ?? "unknown" });
        emit(ctx, { published: r.manifest.name, version: r.manifest.version, activated: r.activated, previous: r.previous, signed: r.manifest.signature !== undefined }, `${r.manifest.name} ${r.manifest.version} ${r.activated ? `is active (previous: ${r.previous ?? "none"}; ${r.manifest.signature ? "signed by " + r.manifest.signature.keyId : "unsigned"})` : "was staged and is NOT active"}\nother microfrontends were not touched; browsers that already loaded ${r.previous ?? "the previous release"} keep working until they reload`);
        return 0;
      } catch (e) { return refuse(e); }
    },
  },
  "frontend:rollback": {
    usage: "pso frontend:rollback <mei> --site <dir> | --env <name> [--to 1.1.0] [--json]",
    summary: "Return one MEI to its previous (or a chosen) published release, after the same compatibility checks; the other microfrontends and the FEI are not touched",
    run(ctx) {
      const { config } = requireWorkspace(ctx);
      const f = pick(config, ctx.positionals[0], "MEI");
      if (f.kind !== "mei") throw new CliError(`"${f.name}" is the FEI: only microfrontends are rolled back independently`, "Publish an earlier FEI version again instead");
      const site = siteOf(ctx, f.name);
      try {
        const r = rollbackMei(site, f.name, str(ctx.flags["to"]), process.env["USERNAME"] ?? process.env["USER"] ?? "unknown");
        emit(ctx, { mei: f.name, ...r }, `${f.name} rolled back from ${r.from ?? "none"} to ${r.to}; the other microfrontends were not touched`);
        return 0;
      } catch (e) { return refuse(e); }
    },
  },
  "frontend:releases": {
    usage: "pso frontend:releases [<mei>] --site <dir> | --env <name> [--json]",
    summary: "Show the published versions of each MEI and of the FEI on a site root: which is active and the activation history",
    run(ctx) {
      const { config } = requireWorkspace(ctx);
      const site = siteOf(ctx, ctx.positionals[0] ? pick(config, ctx.positionals[0]).name : undefined);
      const list = ctx.positionals[0] ? [pick(config, ctx.positionals[0])] : frontends(config);
      const fei = activeFei(site);
      const rows = list.filter((f) => f.kind === "mei").map((f) => ({ name: f.name, active: activePointer(site, f.name)?.version ?? null, versions: versions(site, f.name), history: history(site, f.name) }));
      const out = { fei: fei ? { name: fei.name, version: fei.version, contract: fei.contract } : null, microfrontends: rows };
      emit(ctx, out, [fei ? `${fei.name} ${fei.version} (host contract ${fei.contract})` : "no FEI release is active", ...rows.map((r) => `${r.name.padEnd(16)} active ${String(r.active ?? "-").padEnd(8)} versions: ${r.versions.join(", ") || "(none)"}`)].join("\n"));
      return 0;
    },
  },
  "frontend:config": {
    usage: "pso frontend:config --site <dir> [--fei <name>] [--auth dev-token|oidc|none] [--oidc-issuer <url>] [--oidc-authorize <url>] [--oidc-token <url>] [--oidc-client <id>] [--oidc-scope \"openid\"] [--api-base /api] [--channels-path /channels] [--require-signature] [--trust-signer <name>] [--trust-key <public-or-private-pem>] [--key-id <id>]",
    summary: "Write the FEI's runtime configuration on a site root: where each approved MEI's release pointer is, who may sign releases, how users sign in and the orchestrator's same-origin path. It holds no secret and is never built into the bundle",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const site = siteOf(ctx);
      const loaded = loadFrontends(root, frontends(config));
      const feiFlag = str(ctx.flags["fei"]);
      // several shells: each has its own site and its own runtime configuration, so the command must be told which one
      const shell = feiFlag !== undefined ? feiOf(loaded, feiFlag) : loaded.feis.length === 1 ? loaded.feis[0] : undefined;
      if (!shell) throw new CliError(feiFlag !== undefined ? `Unknown or invalid FEI "${feiFlag}"` : loaded.feis.length > 1 ? `This workspace has ${loaded.feis.length} FEIs: pass --fei <name>` : "This workspace has no valid FEI", loaded.feis.length > 1 ? `Known: ${loaded.feis.map((x) => x.project.name).join(", ")}` : "pso frontend:validate");
      const auth = str(ctx.flags["auth"]) ?? "none";
      if (auth !== "dev-token" && auth !== "oidc" && auth !== "none") throw new CliError(`Invalid --auth "${auth}"`, "Use oidc, dev-token or none");
      let authCfg: NonNullable<ReturnType<typeof readRuntimeConfig>>["auth"];
      if (auth === "oidc") {
        const get = (flag: string): string => { const v = str(ctx.flags[flag]); if (!v) throw new CliError(`--${flag} is required with --auth oidc`); if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(v) && flag !== "oidc-client" && flag !== "oidc-scope") throw new CliError(`--${flag} must be an https:// URL`); return v; };
        authCfg = { kind: "oidc", issuer: get("oidc-issuer"), authorizationEndpoint: get("oidc-authorize"), tokenEndpoint: get("oidc-token"), clientId: get("oidc-client"), ...(str(ctx.flags["oidc-scope"]) ? { scope: str(ctx.flags["oidc-scope"])! } : {}) };
      } else authCfg = auth === "dev-token" ? { kind: "dev-token" } : { kind: "none" };
      const keyFile = str(ctx.flags["trust-key"]), keyId = str(ctx.flags["key-id"]);
      if ((keyFile && !keyId) || (!keyFile && keyId)) throw new CliError("--trust-key and --key-id go together");
      const signerName = str(ctx.flags["trust-signer"]);
      const trustedKeys = [...(keyFile && keyId ? [{ keyId, publicKey: publicKeyRaw(readFileSync(keyFile, "utf8")) }] : []), ...(signerName !== undefined ? [trustedKeyOfSigner(signerName)] : [])];
      if (ctx.flags["require-signature"] === true && !trustedKeys.length) throw new CliError("--require-signature needs at least one --trust-key or --trust-signer", "Only releases signed with a trusted key could be loaded otherwise: none");
      const api = str(ctx.flags["api-base"]) ?? shell.definition.orchestrator.basePath ?? "/api";
      if (!/^(\/[A-Za-z0-9._~-]+)*$/.test(api)) throw new CliError(`Invalid --api-base "${api}"`, "A same-origin path such as /api; the API client never accepts an absolute URL");
      const cfg = writeRuntimeConfig({
        site: (mkdirSync(site, { recursive: true }), site), fei: shell.definition.name, auth: authCfg, orchestratorBasePath: api,
        ...(str(ctx.flags["channels-path"]) ? { channelsPath: str(ctx.flags["channels-path"])! } : {}),
        ...(ctx.flags["require-signature"] === true ? { requireSignature: true } : {}),
        ...(trustedKeys.length ? { trustedKeys } : {}),
        meis: shell.definition.microfrontends.map((m) => m.name),
      });
      emit(ctx, cfg, `wrote ${join(site, "pso-runtime-config.json")}\n  auth: ${cfg.auth?.kind}   api: ${cfg.orchestrator.basePath}   remotes: ${Object.keys(cfg.remotes).join(", ")}   signatures: ${cfg.requireSignature ? "required" : cfg.trustedKeys?.length ? "checked when present" : "not checked"}${auth === "dev-token" ? "\nwarning: dev-token sign-in works only in a build made with --allow-dev-token and is not a production configuration" : ""}`);
      return 0;
    },
  },
  "frontend:nginx": {
    usage: "pso frontend:nginx --site <dir> [--base-path /commerce/] [--server shop.example.com] [--api /api] [--api-port 3000] [--route /catalog/sku/:id,/files/*] [--connect-src https://idp.example.com]",
    summary: "Print a same-origin nginx configuration for a site root (FEI, remotes, API kept apart; restrictive Content-Security-Policy). The managed adapter of the runtime agent generates exactly these locations when the shell is deployed (`pso frontend:declare`), so this is a preview for review",
    run(ctx) {
      requireWorkspace(ctx);
      const base = str(ctx.flags["base-path"]) ?? "/", api = str(ctx.flags["api"]) ?? "/api";
      if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(base)) throw new CliError(`Invalid --base-path "${base}"`);
      if (!/^\/[A-Za-z0-9._~-]+$/.test(api) || ["/_mei", "/_fei", "/_pso"].includes(api) || (base !== "/" && base.startsWith(`${api}/`))) throw new CliError(`Invalid --api "${api}"`, "A single path segment that is not under the frontend's base path");
      const list = (flag: string): string[] => (str(ctx.flags[flag]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const routes = list("route"), connectSrc = list("connect-src");
      try { ctx.print(renderSiteServer({ server: str(ctx.flags["server"]) ?? "_", site: sitePath(ctx), fei: { base, ...(routes.length ? { routes } : {}) }, ...(connectSrc.length ? { connectSrc } : {}), remotes: true, api: { path: api, port: Number(str(ctx.flags["api-port"]) ?? 3000) } })); }
      catch (e) { throw new CliError((e as Error).message.replace(/^invalid site configuration: /, "")); }
      return 0;
    },
  },
  "frontend:declare": {
    usage: "pso frontend:declare <project> --connection <name> [--environment production] [--site <name>] [--base-path /commerce/] [--api-port 3000 | --attach-to <application>] [--orchestrator-path /api] [--channels-path /channels] [--auth none|dev-token|oidc] [--oidc-issuer <url> --oidc-client <id> --oidc-authorize <url> --oidc-token <url> [--oidc-logout <url>]] [--require-signature] [--trust-key <keyId>=<public key>] [--probe-port 8080] [--domain shop.example.com] [--route /catalog/sku/:id,/files/*] [--connect-src https://idp.example.com] [--retain 5] [--dry-run] [--force]",
    summary: "Write deploy/<name>.deployment.pso.ts for a frontend project so the native deployment engine can plan, deploy, verify and roll it back (`pso release:plan`, `release:deploy`, `release:rollback`)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const f = pick(config, ctx.positionals[0]);
      const connection = str(ctx.flags["connection"]);
      if (!connection) throw new CliError("--connection <name> is required", "The connection added with `pso connection:add` (a reference: no credential is written to the declaration)");
      const environment = str(ctx.flags["environment"]) ?? "production";
      const loaded = loadFrontends(root, frontends(config));
      const kind = f.kind;
      const domain = f.name.replace(/^(fei|mei)-/, "");
      // one shell keeps the 0.1 names (<workspace>-fei, site <workspace>); with several shells every shell has its own site and application
      // name, and a MEI is deployed into the site of the shell it is built for
      const multi = loaded.feis.length > 1;
      const shellName = feiOf(loaded, f.name)?.project.name.replace(/^fei-/, "");
      const site = str(ctx.flags["site"]) ?? (multi && shellName ? `${config.name}-${shellName}` : config.name);
      const app = kind === "fei" ? (multi ? `${config.name}-fei-${domain}` : `${config.name}-fei`) : `${config.name}-${domain}`;
      const num = (flag: string, lo: number, hi: number): number | undefined => { const v = str(ctx.flags[flag]); if (v === undefined) return undefined; if (!/^\d{1,5}$/.test(v) || Number(v) < lo || Number(v) > hi) throw new CliError(`Invalid --${flag} "${v}"`, `Use ${lo} to ${hi}`); return Number(v); };
      const retain = num("retain", 2, 100), probe = num("probe-port", 1, 65535), apiPort = num("api-port", 1024, 65535);
      const basePath = str(ctx.flags["base-path"]) ?? "/";
      if (kind === "fei" && !/^\/([A-Za-z0-9._~-]+\/)*$/.test(basePath)) throw new CliError(`Invalid --base-path "${basePath}"`, "Use an absolute path ending in /, the one the shell was built with");
      const attachTo = str(ctx.flags["attach-to"]);
      if (attachTo !== undefined && (kind !== "fei" || !/^[a-z][a-z0-9-]{0,62}$/.test(attachTo))) throw new CliError("--attach-to names the application whose server the SHELL joins", "For example shop-gateway: that application declares nginx.attachPoint");
      if (attachTo !== undefined && apiPort !== undefined) throw new CliError("--api-port and --attach-to exclude each other", "An attached shell reaches the orchestrator through the host server's own routes");
      if (kind === "fei" && apiPort === undefined && attachTo === undefined) throw new CliError("--api-port is required for the shell (or --attach-to <application>)", "The loopback port that always reaches the orchestrator's active release (its `internalPort` in its own deployment declaration)");
      const dom = str(ctx.flags["domain"]);
      if (dom !== undefined && !/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(dom)) throw new CliError(`Invalid --domain "${dom}"`);
      const list = (flag: string): string[] => (str(ctx.flags[flag]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const routes = list("route"), connectSrc = list("connect-src");
      if (kind === "mei" && (routes.length || connectSrc.length)) throw new CliError("--route and --connect-src belong to the shell", "A microfrontend is served through the shell's configuration");
      const oidc = (): Record<string, unknown> => { const need = (n: string): string => { const v = str(ctx.flags[n]); if (!v) throw new CliError(`--${n} is required with --auth oidc`); return v; }; return { kind: "oidc", issuer: need("oidc-issuer"), clientId: need("oidc-client"), authorizationEndpoint: need("oidc-authorize"), tokenEndpoint: need("oidc-token"), ...(str(ctx.flags["oidc-logout"]) ? { logoutEndpoint: str(ctx.flags["oidc-logout"]) } : {}), scope: "openid profile email" }; };
      const authKind = str(ctx.flags["auth"]);
      if (authKind !== undefined && !["none", "dev-token", "oidc"].includes(authKind)) throw new CliError(`Invalid --auth "${authKind}"`, "none, dev-token or oidc");
      const orchPath = str(ctx.flags["orchestrator-path"]);
      const trusted = list("trust-key").map((t) => { const [keyId, publicKey] = t.split("="); if (!keyId || !publicKey) throw new CliError(`Invalid --trust-key "${t}"`, "keyId=<raw ed25519 public key in base64url>"); return { keyId, publicKey }; });
      const wantsConfig = kind === "fei" && (authKind !== undefined || orchPath !== undefined || trusted.length > 0 || ctx.flags["require-signature"] === true);
      if (kind === "mei" && (authKind !== undefined || orchPath !== undefined || trusted.length || str(ctx.flags["attach-to"]) !== undefined)) throw new CliError("--auth, --orchestrator-path, --trust-key and --attach-to belong to the shell");
      const runtimeConfig = wantsConfig ? { orchestratorBasePath: orchPath ?? "/api", ...(str(ctx.flags["channels-path"]) ? { channelsPath: str(ctx.flags["channels-path"]) } : {}), auth: authKind === "oidc" ? oidc() : { kind: authKind ?? "none" }, ...(ctx.flags["require-signature"] === true ? { requireSignature: true } : {}), ...(trusted.length ? { trustedKeys: trusted } : {}) } : undefined;
      const staticDecl = { site, kind, ...(kind === "fei" ? { basePath, ...(attachTo === undefined ? { api: { upstreamPort: apiPort! } } : {}), ...(routes.length ? { routes } : {}), ...(connectSrc.length ? { connectSrc } : {}), ...(runtimeConfig ? { runtimeConfig } : {}) } : {}), ...(retain !== undefined ? { retain } : {}), ...(probe !== undefined ? { probe: { port: probe } } : {}) };
      const decl = {
        name: app, environment, connection: { provider: "ssh", credentials: connection },
        source: { provider: "artifact", path: `${f.path}/dist` },
        services: [{ name: kind === "fei" ? "shell" : domain, runtime: "static", static: staticDecl }],
        strategy: { type: "static", proxy: kind === "fei" ? "nginx" : "none" },
        ...(kind === "fei" ? { proxy: { nginx: attachTo !== undefined ? { attachTo } : { ...(dom ? { domains: [dom] } : {}) } } } : {}),
      };
      const diags = validateDeployment(decl).filter((d) => d.level === "error");
      if (diags.length) throw new CliError(`The generated declaration is invalid:\n${diags.map((d) => `  ${d.path}: ${d.message}`).join("\n")}`);
      const text = `import { defineDeployment } from "@pso/deploy";\n\n// ${kind === "fei" ? "The application shell" : `The ${domain} microfrontend`}, deployed as a static resource by the native engine: the same plan, approval, signature check, lock, history, atomic activation and rollback as a service.\n// ${kind === "fei" ? "Only a shell release changes nginx (validated with nginx -t before a graceful reload); microfrontends are served through its configuration." : "A microfrontend release never touches nginx: one atomic pointer write, after a compatibility check against the active shell."}\n// Build first: pso frontend:build ${f.name}${kind === "fei" ? ` --base-path ${basePath}` : ""}\nexport default defineDeployment(${JSON.stringify(decl, null, 2)});\n`;
      const results = writeFiles(root, { [`deploy/${app}.deployment.pso.ts`]: text }, { dryRun: ctx.flags["dry-run"] === true, force: ctx.flags["force"] === true });
      const code = reportWrites(ctx, results);
      if (code === 0 && ctx.flags["dry-run"] !== true) ctx.print(`next: pso frontend:build ${f.name}${kind === "fei" ? ` --base-path ${basePath}` : ""}   then   pso release:plan ${app}   and   pso release:deploy ${app}`);
      void loaded;
      return code;
    },
  },
  "frontend:contracts": {
    usage: "pso frontend:contracts [--check] [--fail-on-breaking] [--json]",
    summary: "Generate typed frontend contracts from the orchestrator's real route metadata and DTO classes into every frontend project (src/models/contract.generated.ts); --check fails when a project's copy is stale",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const projects = frontends(config);
      if (!projects.length) throw new CliError("This workspace has no frontend projects");
      let c;
      try { c = buildContract(root, config); } catch (e) { throw new CliError((e as Error).message); }
      const ts = renderContractTs(c);
      // what changed since the contract the frontends were last generated from: breaking changes are reported before anything is overwritten
      const prevFile = join(root, "frontend", "contracts", "orchestrator.contract.json");
      let diff: ReturnType<typeof diffContracts> = { breaking: [], additive: [] };
      try { if (existsSync(prevFile)) { const prev = JSON.parse(readFileSync(prevFile, "utf8")) as OrchestratorContract; if (prev.version !== c.version) diff = diffContracts(prev, c); } } catch { /* an unreadable previous copy is just replaced */ }
      const stale: string[] = [];
      for (const p of projects) {
        const file = join(root, ...p.path.split("/"), ...CONTRACT_FILE.split("/"));
        const have = existsSync(file) ? contractVersionOf(readFileSync(file, "utf8")) : undefined;
        if (have !== c.version) stale.push(p.name);
        if (ctx.flags["check"] !== true && have !== c.version) { mkdirSync(join(file, ".."), { recursive: true }); write(file, ts); }
      }
      if (ctx.flags["check"] !== true) { const f = join(root, "frontend", "contracts", "orchestrator.contract.json"); mkdirSync(join(f, ".."), { recursive: true }); write(f, JSON.stringify(c, null, 2) + "\n"); }
      const lim = (a: string[], mark: string): string => a.slice(0, 15).map((x) => `  ${mark} ${x}`).join("\n") + (a.length > 15 ? `\n  ${mark} ... and ${a.length - 15} more (--json lists all)` : "");
      const report = `${diff.breaking.length ? `\nBREAKING since the previous contract:\n${lim(diff.breaking, "-")}` : ""}${diff.additive.length ? `\nadditive:\n${lim(diff.additive, "+")}` : ""}`;
      emit(ctx, { version: c.version, operations: c.operations.length, dtos: Object.keys(c.dtos), breaking: diff.breaking, additive: diff.additive, stale: ctx.flags["check"] === true ? stale : [], updated: ctx.flags["check"] === true ? [] : stale }, `orchestrator contract ${c.version}: ${c.operations.length} operation(s), ${Object.keys(c.dtos).length} DTO(s), ${c.operations.filter((o) => o.responses).length} with declared responses${report}\n${ctx.flags["check"] === true ? (stale.length ? `STALE in: ${stale.join(", ")} (run pso frontend:contracts)` : "all projects are current") : `updated ${stale.length ? stale.join(", ") : "nothing (already current)"}`}`);
      return (ctx.flags["check"] === true && stale.length) || (ctx.flags["fail-on-breaking"] === true && diff.breaking.length) ? 1 : 0;
    },
  },
};
const ARGS: Record<string, number> = { "frontend:publish": 1, "frontend:rollback": 1, "frontend:releases": 1, "frontend:config": 0, "frontend:nginx": 0, "frontend:contracts": 0, "frontend:declare": 1 };
for (const [k, c] of Object.entries(FRONTEND_RELEASE_COMMANDS)) if (c.args === undefined) c.args = ARGS[k]!;
void formatDiagnostic; void validateEcosystem; void saveWorkspace; void writeFileSync;
