import { servicePrefix, type ServiceDecl, type WorkspaceConfig } from "@pso/core";
import { DEFAULT_IMAGES, InfraError, runtimeOf, secretProviderOf, tlsSourceOf, type EnvironmentDecl, type InfraContract, type RuntimeMode } from "./contract.ts";

/** What the infrastructure needs to know about one FEI (read statically from its FEI.pso.ts by the caller). */
export interface FrontendInfo {
  name: string;
  port: number;
  /** FEI.pso.ts security.authentication */
  authentication: "jwt" | "none";
  microfrontends: string[];
  /** scopes the shell's own navigation gates on (for the identity provider's role list) */
  scopes: string[];
  orchestratorBasePath: string;
  /** declared client routes whose last segment may look like a file (nginx) */
  routes: string[];
}

export interface ResolvedFrontend {
  name: string;
  host: string;
  basePath: string;
  /** https://<host>[:port] as the browser sees it */
  origin: string;
  url: string;
  auth: "oidc" | "dev-token" | "none";
  clientId: string;
  /** every OIDC return address the identity provider must accept for this shell (edge URL, plus the dev server in development) */
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  webOrigins: string[];
  devServer: string;
  info: FrontendInfo;
}

export interface ResolvedService {
  name: string;
  runtime: ServiceDecl["runtime"];
  role: "orchestrator" | "service";
  port: number;
  prefix: string;
  mtls: boolean;
  db: boolean;
  dependsOn: string[];
  /** how other containers reach it (DNS name on the private network: never localhost) */
  containerUrl: string;
  /** how processes on this machine reach it */
  hostUrl: string;
  decl: ServiceDecl;
}

export interface ResolvedIdentity {
  provider: "keycloak" | "pso-dev" | "external";
  realm: string;
  audience: string;
  host: string;
  /** the `iss` claim every token carries: the address the browser uses */
  issuer: string;
  /** JWKS as a container sees it, and as a process on this machine sees it */
  jwksContainer: string;
  jwksHost: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  logoutEndpoint?: string;
  /** host:port pairs that services must explicitly approve as private JWKS hosts */
  privateHostsContainer: string[];
  privateHostsHost: string[];
  algorithms: string;
  users: Array<{ username: string; scopes: string[]; email?: string }>;
  scopes: string[];
}

export interface Topology {
  env: string;
  decl: EnvironmentDecl;
  kind: EnvironmentDecl["kind"];
  runtime: RuntimeMode;
  domain: string;
  httpsPort: number;
  tlsSource: ReturnType<typeof tlsSourceOf>;
  secretProvider: ReturnType<typeof secretProviderOf>;
  project: string;
  api: { host: string; origin: string };
  frontends: ResolvedFrontend[];
  services: ResolvedService[];
  orchestrator?: ResolvedService;
  identity?: ResolvedIdentity;
  /** every public host name the edge gateway answers for */
  publicHosts: string[];
  images: { nginx: string; postgres: string; keycloak: string };
  logs: { maxSize: string; maxFile: number };
}

const portSuffix = (p: number): string => (p === 443 ? "" : `:${p}`);
const label = (fei: string): string => fei.replace(/^fei-/, "");

export function resolveTopology(ws: WorkspaceConfig, c: InfraContract, envName: string, frontends: FrontendInfo[], extraScopes: string[] = []): Topology {
  const decl = c.environments[envName];
  if (!decl) throw new InfraError(`unknown environment "${envName}"`, "PSO_INFRA_ENV_UNKNOWN");
  const httpsPort = decl.httpsPort ?? (decl.kind === "development" ? 8443 : 443);
  const fqdn = (key: string, lbl: string): string => decl.hosts?.[key] ?? `${lbl}.${decl.domain}`;
  const origin = (host: string): string => `https://${host}${portSuffix(httpsPort)}`;
  const api = { host: fqdn("api", c.api?.host ?? "api"), origin: "" };
  api.origin = origin(api.host);

  const orch = ws.services.find((s) => s.role === "orchestrator");
  const services: ResolvedService[] = ws.services.map((s) => {
    const role = s.role === "orchestrator" ? "orchestrator" as const : "service" as const;
    const mtls = role === "service" && c.services?.[s.name]?.mtls === true;
    return {
      name: s.name, runtime: s.runtime, role, port: s.port, prefix: servicePrefix(s), mtls, db: s.db === "postgres",
      dependsOn: s.dependsOn ?? [],
      // a container never reaches another one through localhost: it is the container's own loopback
      containerUrl: `https://${s.name}:${s.port}`,
      hostUrl: `http://127.0.0.1:${s.port}`,
      decl: s,
    };
  });

  const id = c.identity && c.identity.provider !== "none" ? c.identity : undefined;
  let identity: ResolvedIdentity | undefined;
  const allScopes = [...new Set([...frontends.flatMap((f) => f.scopes), ...extraScopes, ...(id?.users ?? []).flatMap((u) => u.scopes).filter((s) => s !== "*")])].sort();
  // a development user with the scope "*" holds every scope the declarations use (they follow new routes and frontends without an edit)
  const usersOf = (us: Array<{ username: string; scopes: string[]; email?: string }>) => us.map((u) => (u.scopes.includes("*") ? { ...u, scopes: [...new Set([...allScopes, ...u.scopes.filter((s) => s !== "*")])].sort() } : u));
  if (id) {
    const realm = id.realm ?? ws.name;
    const host = fqdn("identity", id.host ?? "auth");
    const audience = id.audience ?? "pso-api";
    if (id.provider === "keycloak") {
      const iss = `${origin(host)}/realms/${realm}`;
      const oidc = `${iss}/protocol/openid-connect`;
      identity = {
        provider: "keycloak", realm, audience, host, issuer: iss,
        jwksContainer: `https://idp:8443/realms/${realm}/protocol/openid-connect/certs`,
        jwksHost: `https://127.0.0.1:${httpsPort}/realms/${realm}/protocol/openid-connect/certs`,
        authorizationEndpoint: `${oidc}/auth`, tokenEndpoint: `${oidc}/token`, logoutEndpoint: `${oidc}/logout`,
        privateHostsContainer: ["idp:8443"], privateHostsHost: [`127.0.0.1:${httpsPort}`], algorithms: "RS256",
        users: decl.kind === "development" ? usersOf(id.users ?? []) : [], scopes: allScopes,
      };
    } else if (id.provider === "pso-dev") {
      const iss = origin(host);
      identity = {
        provider: "pso-dev", realm, audience, host, issuer: iss,
        jwksContainer: `https://edge:8443/.well-known/jwks.json`, jwksHost: `https://127.0.0.1:${httpsPort}/.well-known/jwks.json`,
        authorizationEndpoint: "", tokenEndpoint: "", privateHostsContainer: ["edge:8443"], privateHostsHost: [`127.0.0.1:${httpsPort}`], algorithms: "ES256",
        users: usersOf(id.users ?? []), scopes: allScopes,
      };
    } else {
      const e = decl.identity ?? {};
      if (!e.issuer || !e.jwksUri) throw new InfraError(`environment "${envName}": the external identity provider needs identity.issuer and identity.jwksUri`, "PSO_INFRA_IDENTITY_EXTERNAL");
      identity = {
        provider: "external", realm, audience, host: new URL(e.issuer).host, issuer: e.issuer, jwksContainer: e.jwksUri, jwksHost: e.jwksUri,
        authorizationEndpoint: e.authorizationEndpoint ?? "", tokenEndpoint: e.tokenEndpoint ?? "", ...(e.logoutEndpoint ? { logoutEndpoint: e.logoutEndpoint } : {}),
        privateHostsContainer: [], privateHostsHost: [], algorithms: "RS256", users: [], scopes: allScopes,
      };
    }
  }

  const resolved: ResolvedFrontend[] = frontends.map((f) => {
    const fc = c.frontends?.[f.name] ?? {};
    const host = fqdn(f.name, fc.host ?? label(f.name));
    const basePath = fc.basePath ?? "/";
    const o = origin(host);
    // the shell decides whether it authenticates; the contract decides HOW in this environment
    const auth = f.authentication === "none" ? "none" : fc.auth ?? (identity && identity.provider !== "pso-dev" ? "oidc" : "dev-token");
    if (auth === "dev-token" && decl.kind === "production") throw new InfraError(`${f.name}: dev-token sign-in is not accepted in the production environment "${envName}"`, "PSO_INFRA_DEV_TOKEN_PRODUCTION", "Declare an identity provider (keycloak or external) or set frontends.<fei>.auth to oidc");
    const devServer = `http://localhost:${f.port}`;
    const redirectUris = [`${o}${basePath}auth/callback`, ...(decl.kind === "development" ? [`${devServer}/auth/callback`] : [])];
    return {
      name: f.name, host, basePath, origin: o, url: `${o}${basePath}`, auth, clientId: fc.clientId ?? f.name,
      redirectUris, postLogoutRedirectUris: [`${o}${basePath}`, ...(decl.kind === "development" ? [`${devServer}/`] : [])],
      webOrigins: [o, ...(decl.kind === "development" ? [devServer] : [])], devServer, info: f,
    };
  });

  // two shells on one host must not claim overlapping base paths: the edge could not tell their requests apart
  for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length; j++) {
    const a = resolved[i]!, b = resolved[j]!;
    if (a.host === b.host && (a.basePath.startsWith(b.basePath) || b.basePath.startsWith(a.basePath))) throw new InfraError(`${a.name} and ${b.name} are both served on ${a.host} with overlapping base paths (${a.basePath}, ${b.basePath})`, "PSO_INFRA_HOST_CONFLICT", `Give one of them its own host (frontends.${b.name}.host) or a separate base path`);
  }
  const reserved = new Map<string, string>([[api.host, "the API"], ...(identity && identity.provider !== "external" ? [[identity.host, "the identity provider"] as [string, string]] : [])]);
  for (const f of resolved) { const r = reserved.get(f.host); if (r) throw new InfraError(`${f.name} is served on ${f.host}, which is the host of ${r}`, "PSO_INFRA_HOST_CONFLICT", `Choose another host label in frontends.${f.name}.host`); }
  if (identity && identity.provider !== "external" && identity.host === api.host) throw new InfraError(`the API and the identity provider cannot share the host ${api.host}`, "PSO_INFRA_HOST_CONFLICT");

  for (const s of services) for (const d of s.dependsOn) if (!services.some((x) => x.name === d)) throw new InfraError(`service "${s.name}" depends on unknown service "${d}"`, "PSO_INFRA_DEPENDENCY");
  for (const n of Object.keys(c.services ?? {})) if (!services.some((s) => s.name === n)) throw new InfraError(`${"pso.infra.json"} configures service "${n}", which pso.workspace.json does not declare`, "PSO_INFRA_UNKNOWN_SERVICE");
  for (const n of Object.keys(c.frontends ?? {})) if (!frontends.some((f) => f.name === n)) throw new InfraError(`pso.infra.json configures frontend "${n}", which is not a FEI of this workspace`, "PSO_INFRA_UNKNOWN_FRONTEND");
  for (const s of Object.values(c.services ?? {})) for (const sec of s.secrets ?? []) if (!c.secrets?.[sec]) throw new InfraError(`secret "${sec}" is used by a service but not declared in "secrets"`, "PSO_INFRA_UNKNOWN_SECRET");

  const publicHosts = [...new Set([...resolved.map((f) => f.host), api.host, ...(identity && identity.provider !== "external" ? [identity.host] : [])])].sort();
  return {
    env: envName, decl, kind: decl.kind, runtime: runtimeOf(decl), domain: decl.domain, httpsPort, tlsSource: tlsSourceOf(decl), secretProvider: secretProviderOf(decl),
    project: c.docker?.project ?? `${ws.name}-${envName}`.replace(/[^a-z0-9_-]/g, "-"),
    api, frontends: resolved, services, ...(orch ? { orchestrator: services.find((s) => s.name === orch.name)! } : {}), ...(identity ? { identity } : {}), publicHosts,
    images: { ...DEFAULT_IMAGES, ...(c.docker?.images ?? {}) }, logs: { maxSize: c.docker?.logs?.maxSize ?? "10m", maxFile: c.docker?.logs?.maxFile ?? 3 },
  };
}

/** The address one component uses to reach a service, for the place it runs in. */
export function addressOf(t: Topology, service: string, from: "container" | "host"): string {
  const s = t.services.find((x) => x.name === service);
  if (!s) throw new InfraError(`unknown service "${service}"`, "PSO_INFRA_UNKNOWN_SERVICE");
  return from === "container" ? s.containerUrl : s.hostUrl;
}
