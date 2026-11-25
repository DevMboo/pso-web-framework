import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { frameworkSpecs } from "../specs.ts";
import { extractContracts, renderContracts } from "./contracts.ts";
import type { Detection, IntegrationAdapter, IntegrationPlan, ProjectInfo } from "./core.ts";
import { isOrchestratorDir } from "../project-structure.ts";

/**
 * React + TypeScript adapter. Supported: React 18 and 19 with TypeScript, any bundler. It detects the application, writes three small
 * application-owned files and installs the two official packages; it never edits App.tsx or the router (the provider is added by hand,
 * with the exact snippet printed at the end).
 */
const MARKER_CLIENT = "pso:integration react channels";
const MARKER_CHANNELS = "pso:integration react channels hooks";
const major = (range: string): number | undefined => { const m = /(\d+)\.\d+/.exec(range) ?? /(\d+)/.exec(range); return m ? Number(m[1]) : undefined; };

function installedVersion(root: string, name: string): string | undefined {
  try { return (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: string }).version; } catch { return undefined; }
}
function tsconfigOf(root: string): string | undefined {
  // Vite projects keep the real options in tsconfig.app.json and a references-only tsconfig.json
  for (const f of ["tsconfig.app.json", "tsconfig.json"]) if (existsSync(join(root, f))) return join(root, f);
  return undefined;
}
function bundlerOf(deps: Record<string, string>): "vite" | "cra" | "other" { return deps["vite"] ? "vite" : deps["react-scripts"] ? "cra" : "other"; }

const envRead = (b: "vite" | "cra" | "other"): string => b === "vite"
  ? `(import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_PSO_CHANNELS_URL`
  : b === "cra" ? `process.env.REACT_APP_PSO_CHANNELS_URL`
  : `(globalThis as { PSO_CHANNELS_URL?: string }).PSO_CHANNELS_URL`;
const envName = (b: "vite" | "cra" | "other"): string => (b === "vite" ? "VITE_PSO_CHANNELS_URL" : b === "cra" ? "REACT_APP_PSO_CHANNELS_URL" : "globalThis.PSO_CHANNELS_URL");

export function clientSource(bundler: "vite" | "cra" | "other"): string {
  return `// ${MARKER_CLIENT}: the PSO Channels connection of this application (yours to edit).
import { createPsoChannels, type PsoChannels } from "@pso/channels-client";

/**
 * Returns the application's CURRENT access token (the one your HTTP calls already send). Implement it with your authentication library.
 * It is called after every (re)connection and shortly before the token expires, so refresh the token here. The integration keeps
 * no credentials in browser storage: the token lives only where your authentication library keeps it.
 */
export type TokenProvider = () => string | Promise<string>;

/**
 * The WebSocket endpoint of your PSO orchestrator. Set \`${envName(bundler)}\` (for example wss://api.example.com/channels).
 * Without it the page's own origin is used ("/channels"), which works when the orchestrator is served behind the same host.
 * Use wss:// outside local development: the client refuses unencrypted ws:// to any host except localhost.
 */
export function channelsUrl(): string {
  return ${envRead(bundler)} ?? "/channels";
}

export function createPsoClient(getToken: TokenProvider): PsoChannels {
  return createPsoChannels({ url: channelsUrl(), getToken });
}
`;
}

export const CHANNELS_SOURCE = `// ${MARKER_CHANNELS}: typed channel hooks bound to the generated contracts (yours to edit).
import { createElement, useRef, type ReactNode } from "react";
import { PsoChannelsRoot, usePsoChannelEvents, usePsoConnection, type UsePsoChannelEventsResult } from "@pso/react-channels";
import type { PsoChannels } from "@pso/channels-client";
import { createPsoClient, type TokenProvider } from "./client";
import type { ChannelContracts } from "./types";

export { usePsoConnection };
export type { ChannelContracts };

type Pattern = keyof ChannelContracts & string;
const VALUE = /^[A-Za-z0-9_-]{1,64}$/;

/** Fills the parameters of a channel pattern: channelName("candidate.{candidateId}", { candidateId: "c1" }) is "candidate.c1". */
export function channelName<K extends Pattern>(pattern: K, params: ChannelContracts[K]["params"]): string {
  return pattern.replace(/\\{(\\w+)\\}/g, (_m, key: string) => {
    const v = (params as Record<string, string>)[key];
    if (typeof v !== "string" || !VALUE.test(v)) throw new Error(\`invalid value for {\${key}} of channel "\${pattern}"\`);
    return v;
  });
}

/**
 * Subscribes while the component is mounted. \`events\` is typed from the contract of the channel; pass \`null\` as params to wait
 * (for example until an id is known). Whether the subscription is allowed is decided by the server: handle \`error\`.
 */
export function useChannel<K extends Pattern>(pattern: K, params: ChannelContracts[K]["params"] | null, opts: { maxEvents?: number } = {}): UsePsoChannelEventsResult<ChannelContracts[K]["events"]> {
  return usePsoChannelEvents<ChannelContracts[K]["events"]>(params === null ? null : channelName(pattern, params), opts);
}

/** Sends a typed client command to a channel the user is subscribed to (the server validates and authorizes it again). */
export function sendCommand<K extends Pattern, C extends keyof ChannelContracts[K]["commands"] & string>(client: PsoChannels, pattern: K, params: ChannelContracts[K]["params"], command: C, payload: ChannelContracts[K]["commands"][C]): Promise<unknown> {
  return client.send(channelName(pattern, params), command, payload);
}

/**
 * Put it once near the root. \`sessionKey\` is anything that changes when the session changes (the user id): the connection re-authenticates
 * and the server re-authorizes every subscription. \`enabled={false}\` (for example while logged out) closes the connection.
 */
export function PsoProvider(props: { getToken: TokenProvider; sessionKey?: unknown; enabled?: boolean; children?: ReactNode }) {
  const token = useRef(props.getToken);
  token.current = props.getToken; // always the latest function, without recreating the client
  return createElement(PsoChannelsRoot, { create: () => createPsoClient(() => token.current()), ...(props.enabled !== undefined ? { enabled: props.enabled } : {}), sessionKey: props.sessionKey }, props.children);
}
`;

export const PROVIDER_SNIPPET = (dir: string): string => `Add the provider once, near the root of your application (this installer never edits App.tsx or your router):

  import { PsoProvider } from "./${dir}/channels";

  <PsoProvider getToken={() => auth.getAccessToken()} sessionKey={auth.userId}>
    <App />
  </PsoProvider>

and use it in a component:

  import { useChannel } from "./${dir}/channels";
  const { status, events, error } = useChannel("candidate.{candidateId}", { candidateId });`;

export const reactAdapter: IntegrationAdapter = {
  framework: "react",
  integrations: ["channels"],

  detect(project: ProjectInfo, flags): Detection {
    const problems: string[] = [], warnings: string[] = [], facts: Record<string, string> = {};
    const reactRange = project.deps["react"];
    if (!reactRange) problems.push("React is not a dependency of this project (no \"react\" in dependencies). Run the command in an existing React application; it never creates one");
    else {
      const version = installedVersion(project.root, "react") ?? reactRange;
      const mj = major(version);
      facts["react"] = installedVersion(project.root, "react") ? version : `${reactRange} (not installed yet)`;
      if (mj === undefined) warnings.push(`cannot tell which React version "${reactRange}" is: React 18 or later is required`);
      else if (mj < 18) problems.push(`React ${version} is not supported: @pso/react-channels needs React 18 or later (useSyncExternalStore)`);
    }
    const tsconfig = tsconfigOf(project.root);
    const hasTs = !!(project.deps["typescript"] || installedVersion(project.root, "typescript"));
    if (!tsconfig) problems.push("No tsconfig.json found: this integration is for React + TypeScript projects");
    else facts["tsconfig"] = relative(project.root, tsconfig);
    if (!hasTs) problems.push("TypeScript is not installed (no \"typescript\" dependency)");
    else { facts["typescript"] = installedVersion(project.root, "typescript") ?? project.deps["typescript"]!; const tj = major(facts["typescript"]!); if (tj !== undefined && tj < 5) warnings.push(`TypeScript ${facts["typescript"]}: version 5 or later is what the integration is tested with`); }
    const b = bundlerOf(project.deps);
    facts["bundler"] = b === "other" ? "not Vite or Create React App (the endpoint is read from globalThis.PSO_CHANNELS_URL)" : b;
    const dir = typeof flags["dir"] === "string" ? flags["dir"] : existsSync(join(project.root, "src")) ? "src/integrations/pso" : undefined;
    if (!dir) problems.push("No src/ folder found: choose where the application-owned files go with --dir <folder>");
    else { if (/^([A-Za-z]:|\/|\\)/.test(dir) || dir.split(/[\\/]/).includes("..")) problems.push(`--dir "${dir}" must be a relative folder inside the project`); facts["folder"] = dir.replace(/\\/g, "/"); }
    for (const [name, label] of [["@pso/channels-client", "client"], ["@pso/react-channels", "react"]] as const) {
      const have = project.deps[name];
      if (have && !/^(\^|~)?0\.1\.|^file:|^workspace:|^\*$|^latest$/.test(have)) warnings.push(`${name}@${have} is already a dependency; it is kept as it is (this installer supports 0.1.x)`);
      void label;
    }
    return { problems, warnings, facts };
  },

  plan(project, _integration, flags, facts): IntegrationPlan {
    const specs = frameworkSpecs();
    const dir = facts["folder"]!;
    const bundler = bundlerOf(project.deps);
    // contracts: from an orchestrator given with --contracts, or the orchestrator of the PSO workspace this application lives in
    let source = typeof flags["contracts"] === "string" ? resolve(project.root, flags["contracts"]) : undefined;
    if (!source) {
      for (let d = project.root, i = 0; i < 6; i++, d = dirname(d)) {
        const ws = join(d, "pso.workspace.json");
        if (existsSync(ws)) {
          try { const o = (JSON.parse(readFileSync(ws, "utf8")) as { services: Array<{ path: string; role?: string; runtime: string }> }).services.find((s) => s.role === "orchestrator" && s.runtime === "node"); if (o) source = join(d, ...o.path.split("/")); } catch { /* no usable workspace */ }
          break;
        }
        if (dirname(d) === d) break;
      }
    }
    const notes: string[] = [];
    let types: string;
    if (source && isOrchestratorDir(source)) {
      const c = extractContracts(source);
      const r = renderContracts(c);
      types = r.text;
      for (const w of r.warnings) notes.push(`contracts warning: ${w}`);
      notes.push(`contracts: ${c.channels.length} channel(s) from ${relative(project.root, source) || "."} (regenerate with: pso channels:contracts --from ${relative(project.root, source) || "."})`);
    } else {
      types = renderContracts({ channels: [], dtos: new Map(), warnings: [] }).text;
      notes.push("contracts: no orchestrator found, so types.ts has no channels yet. Generate them with: pso channels:contracts --from <path to your orchestrator>");
    }
    notes.push(PROVIDER_SNIPPET(dir.replace(/^src\//, "")));
    notes.push(`configure the endpoint: ${bundler === "vite" ? "VITE_PSO_CHANNELS_URL" : bundler === "cra" ? "REACT_APP_PSO_CHANNELS_URL" : "globalThis.PSO_CHANNELS_URL"}=wss://<your orchestrator>/channels; allow your site's origin on the orchestrator (PSO_CHANNELS_ALLOWED_ORIGINS=https://your-app.example)`);
    return {
      packages: [{ name: "@pso/channels-client", spec: specs.channelsClientSpec }, { name: "@pso/react-channels", spec: specs.reactChannelsSpec }],
      files: [
        { path: `${dir}/client.ts`, content: clientSource(bundler), marker: MARKER_CLIENT },
        { path: `${dir}/channels.ts`, content: CHANNELS_SOURCE, marker: MARKER_CHANNELS },
        { path: `${dir}/types.ts`, content: types, marker: "pso:generated contracts" },
      ],
      notes,
    };
  },

  /** Type-checks the generated files with the project's own compiler options; only diagnostics located in those files count. */
  verify(project, plan): string[] {
    const config = tsconfigOf(project.root);
    if (!config) return [];
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config ?? {}, ts.sys, dirname(config));
    const roots = plan.files.map((f) => resolve(project.root, f.path));
    const program = ts.createProgram(roots, { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined, skipLibCheck: true });
    const own = new Set(roots.map((r) => r.replace(/\\/g, "/").toLowerCase()));
    return ts.getPreEmitDiagnostics(program).filter((d) => d.file && own.has(d.file.fileName.replace(/\\/g, "/").toLowerCase())).map((d) => `${relative(project.root, d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).slice(0, 10);
  },
};
