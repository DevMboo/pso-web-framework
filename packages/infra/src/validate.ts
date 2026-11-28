import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INFRA_DIR } from "./contract.ts";
import { plan, type EngineHooks, type Plan } from "./engine.ts";
import { abs, readText } from "./fsutil.ts";
import { environmentCa, localResolution } from "./identity.ts";
import { netRequest } from "./net.ts";
import { DISCLOSURE } from "./edge.ts";
import { paths } from "./render.ts";
import { lookupSecret, redact } from "./secrets.ts";

export interface Finding { severity: "error" | "warning" | "info"; code: string; subject: string; message: string; hint?: string }
export interface ValidationReport { ok: boolean; environment: string; findings: Finding[]; plan: Plan; probes: ProbeResult[] }
export interface ProbeResult { name: string; url: string; ok: boolean; status?: number; timeMs?: number; detail: string }

/**
 * Validation is stricter than planning: it turns every state that would make the environment unsafe or unusable into a finding, checks that
 * no secret value leaked into generated configuration or version control, and (with `probe`) verifies the running environment for real:
 * TLS handshakes against the environment's authority and host name, the security headers the edge must send, the API's readiness through
 * the whole chain, and the identity provider's discovery document (issuer and endpoints match what the services were configured with).
 */
export async function validate(root: string, o: { env?: string; probe?: boolean; hooks?: EngineHooks } = {}): Promise<ValidationReport> {
  const p = plan(root, o.env, o.hooks ?? {});
  const t = p.topology;
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push({ ...f, message: redact(f.message) });
  for (const i of p.issues) add({ severity: i.severity, code: i.code, subject: i.path, message: i.message, ...(i.hint ? { hint: i.hint } : {}) });
  for (const r of p.resources) {
    const why = r.reasons.join("; ");
    switch (r.status) {
      case "missing": add({ severity: "error", code: "PSO_INFRA_MISSING", subject: r.id, message: `${r.description}: ${why || "missing"}`, hint: r.action === "supply" ? "Supply it (see pso infra:inspect)" : `pso infra:apply --env ${p.environment}` }); break;
      case "invalid": add({ severity: "error", code: "PSO_INFRA_INVALID", subject: r.id, message: `${r.description}: ${why}`, hint: r.owner === "pso" ? `pso infra:repair --env ${p.environment}` : "Replace it with a valid one from your certificate authority" }); break;
      case "exposed": add({ severity: "error", code: "PSO_INFRA_EXPOSED", subject: r.id, message: `${why}`, hint: `pso infra:repair --env ${p.environment} restricts it to its owner` }); break;
      case "outdated": add({ severity: "warning", code: "PSO_INFRA_OUTDATED", subject: r.id, message: `${r.description}: ${why}`, hint: `pso infra:apply --env ${p.environment}` }); break;
      case "drifted": add({ severity: "warning", code: "PSO_INFRA_DRIFT", subject: r.id, message: `${r.files[0]?.path}: ${why}`, hint: `Move the change into the declarations, then pso infra:repair --env ${p.environment} (the edited file is backed up)` }); break;
      case "external-missing": add({ severity: "error", code: "PSO_INFRA_EXTERNAL_MISSING", subject: r.id, message: `${r.description}: ${why}`, hint: "This resource is supplied by the operator: PSO never generates it for this environment" }); break;
      case "external-unverified": add({ severity: "info", code: "PSO_INFRA_EXTERNAL_UNVERIFIED", subject: r.id, message: `${r.description}: ${why}` }); break;
      default: break;
    }
    for (const w of r.warnings) add({ severity: "warning", code: "PSO_INFRA_WARNING", subject: r.id, message: w });
  }
  // a secret value must never appear in any generated file, in the workspace's own environment files, or outside .infra/secrets
  const values: Array<{ name: string; value: string }> = [];
  for (const r of p.resources.filter((x) => x.kind === "secret")) { const l = lookupSecret(root, p.environment, t.secretProvider, r.id.slice(7), t.decl.secrets?.dir); if (l.value && l.value.length >= 12) values.push({ name: r.id.slice(7), value: l.value }); }
  const scan = [...p.resources.filter((x) => x.kind === "config").map((x) => x.files[0]!.path), ".env", "docker-compose.yml", INFRA_FILE_LIST].flat();
  for (const f of scan) { const text = readText(abs(root, f)); if (!text) continue; for (const v of values) if (text.includes(v.value)) add({ severity: "error", code: "PSO_INFRA_SECRET_LEAK", subject: f, message: `contains the value of secret "${v.name}"`, hint: "Replace it with a reference (secret://<name>) and rotate the secret: pso infra:rotate secret:" + v.name }); }
  const gi = readText(abs(root, ".gitignore")) ?? "";
  if (!gi.split(/\r?\n/).some((l) => /^\/?\.infra\/?\*{0,2}$/.test(l.trim()))) add({ severity: "error", code: "PSO_INFRA_NOT_IGNORED", subject: ".gitignore", message: ".infra/ is not excluded from version control: keys and secrets could be committed", hint: `pso infra:apply --env ${p.environment}` });
  if (existsSync(join(root, ".git")) && existsSync(join(root, ".git", "index"))) {
    const idx = readFileSync(join(root, ".git", "index"));
    if (idx.includes(Buffer.from(".infra/secrets/")) || idx.includes(Buffer.from(".infra/ca/"))) add({ severity: "error", code: "PSO_INFRA_COMMITTED", subject: ".git", message: "files under .infra/secrets or .infra/ca are tracked by git", hint: "git rm --cached -r .infra, then rotate every secret and certificate that was committed" });
  }
  const probes: ProbeResult[] = o.probe ? await probe(root, p) : [];
  for (const r of probes.filter((x) => !x.ok)) add({ severity: "error", code: "PSO_INFRA_PROBE", subject: r.name, message: `${r.url}: ${r.detail}` });
  return { ok: !findings.some((f) => f.severity === "error"), environment: p.environment, findings, plan: p, probes };
}
const INFRA_FILE_LIST = ["pso.infra.json"];

/** Live checks against the running containers of the environment, through the edge, with full certificate verification. */
export async function probe(root: string, p: Plan, override: { ca?: string; resolve?: Record<string, string> } = {}): Promise<ProbeResult[]> {
  const t = p.topology;
  // a remote environment is probed through an SSH tunnel: its public names map to the tunnel, its authority is the operator's
  const ca = override.ca ?? environmentCa(root, t);
  const resolve = override.resolve ?? localResolution(t);
  const out: ProbeResult[] = [];
  const check = async (name: string, url: string, test: (r: Awaited<ReturnType<typeof netRequest>>) => string | undefined, headers: Record<string, string> = {}) => {
    try {
      const r = await netRequest({ url, headers, ...(ca ? { ca } : {}), resolve, timeoutMs: 10_000 });
      const problem = test(r);
      out.push({ name, url, ok: !problem, status: r.status, timeMs: r.timeMs, detail: problem ?? `HTTP ${r.status}, TLS verified (${r.tls?.protocol ?? "?"})` });
    } catch (e) { out.push({ name, url, ok: false, detail: (e as Error).message }); }
  };
  for (const f of t.frontends) {
    await check(`${f.name}: shell`, f.url, (r) => r.status !== 200 ? `HTTP ${r.status} (is a release published? pso frontend:publish ${f.name} --env ${t.env})` : !String(r.headers["strict-transport-security"] ?? "") ? "no Strict-Transport-Security header" : !/frame-ancestors 'none'/.test(String(r.headers["content-security-policy"] ?? "")) ? "no restrictive Content-Security-Policy" : undefined);
    await check(`${f.name}: runtime configuration`, `${f.origin}${f.basePath}pso-runtime-config.json`, (r) => { if (r.status !== 200) return `HTTP ${r.status}`; try { const j = JSON.parse(r.body.toString("utf8")) as { fei?: string; auth?: { kind?: string } }; return j.fei !== f.name ? `serves the configuration of ${j.fei}` : j.auth?.kind !== f.auth ? `auth is ${j.auth?.kind}, expected ${f.auth}` : undefined; } catch { return "not JSON"; } });
  }
  if (t.orchestrator) {
    await check("api: readiness through the edge", `${t.api.origin}/health/ready`, (r) => (r.status === 200 ? undefined : `HTTP ${r.status}`));
    if (t.frontends[0]) await check(`api: same-origin path of ${t.frontends[0].name}`, `${t.frontends[0].origin}${t.frontends[0].info.orchestratorBasePath}/health/ready`, (r) => (r.status === 200 ? undefined : `HTTP ${r.status}`));
  }
  if (t.identity?.provider === "keycloak") await check("identity: discovery", `${t.identity.issuer}/.well-known/openid-configuration`, (r) => { if (r.status !== 200) return `HTTP ${r.status}`; const j = JSON.parse(r.body.toString("utf8")) as { issuer?: string; token_endpoint?: string }; return j.issuer !== t.identity!.issuer ? `issuer is ${j.issuer}, the services expect ${t.identity!.issuer}` : j.token_endpoint !== t.identity!.tokenEndpoint ? `token endpoint ${j.token_endpoint} differs from the configured ${t.identity!.tokenEndpoint}` : undefined; });
  if (t.identity?.provider === "pso-dev") await check("identity: public keys", `${t.identity.issuer}/.well-known/jwks.json`, (r) => (r.status === 200 && /"keys"/.test(r.body.toString()) ? undefined : `HTTP ${r.status}`));
  // a host the edge does not serve is refused: either the TLS handshake fails (no certificate names it) or the default server answers 421
  {
    const unknown = `pso-unknown-host.${t.domain}`;
    const url = `https://${unknown}:${t.httpsPort}/`;
    try { const r = await netRequest({ url, ...(ca ? { ca } : {}), resolve: { ...resolve, [unknown]: "127.0.0.1" }, timeoutMs: 10_000 }); const leak = disclosed(r); out.push({ name: "edge: unknown host is refused", url, ok: r.status === 421 && !leak, status: r.status, timeMs: r.timeMs, detail: r.status !== 421 ? `HTTP ${r.status}: a request for an unknown host must be refused` : leak ? `HTTP 421, but ${leak}` : "HTTP 421 from the default server, sanitized" }); }
    catch (e) { const m = (e as Error).message; const refused = /altnames|does not match|certificate/i.test(m); out.push({ name: "edge: unknown host is refused", url, ok: refused, detail: refused ? "refused during the TLS handshake (no certificate names it)" : m }); }
  }
  // plain HTTP sent to the TLS port is answered by the edge itself: a sanitized 400, without its software or nginx's own message
  {
    const host = t.frontends[0]?.host ?? t.api.host;
    const url = `http://${host}:${t.httpsPort}/`;
    try { const r = await netRequest({ url, resolve, timeoutMs: 10_000 }); const leak = disclosed(r); out.push({ name: "edge: plain HTTP on the TLS port", url, ok: r.status === 400 && !leak, status: r.status, timeMs: r.timeMs, detail: r.status !== 400 ? `HTTP ${r.status}, expected 400` : leak ? `HTTP 400, but ${leak}` : "HTTP 400, sanitized (no server identification, no native message)" }); }
    catch (e) { out.push({ name: "edge: plain HTTP on the TLS port", url, ok: false, detail: (e as Error).message }); }
  }
  return out;
}
void paths;

/** What an edge-generated response gives away, if anything (an rc.7 edge, or an edge running an image other than the framework's). */
function disclosed(r: Awaited<ReturnType<typeof netRequest>>): string | undefined {
  if (r.headers["server"]) return `it sends Server: ${String(r.headers["server"])}`;
  if (r.headers["x-powered-by"]) return "it sends X-Powered-By";
  if (DISCLOSURE.test(r.body.toString("utf8").replace(/<style>[\s\S]*?<\/style>/g, ""))) return "its body names the technology or the internal error (the edge does not run the framework's edge image: pso infra:apply, then pso docker:up)";
  return undefined;
}
