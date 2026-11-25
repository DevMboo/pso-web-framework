// PSD distribution policy: every file that may enter the distribution must match exactly one explicit rule below, in a classification.
//
//   A  framework implementation     strongest protection (bundled / minified / mangled, no maps, no sources)
//   B  public development SDK       readable runtime + type declarations required by supported developer workflows
//   C  developer-owned source       templates and examples that become the developer's own editable code
//   D  public documentation         sanitized docs and the documentation portal
//   T  third-party runtime          unmodified dependency, licence and notice files retained
//   M  installation metadata        launcher shims, manifests
//   E  restricted                   never distributed: a staged file that matches an E rule is DROPPED and reported, never silently kept
//
// Rules are evaluated in order, the first match wins. A file that matches no rule is UNKNOWN and fails the release gate.
// This file names internal indicators on purpose (it is maintainer tooling and is never part of an artifact).

const P = "node_modules/@pso/";
const rule = (cls, id, re, note) => ({ cls, id, re, note });

export const PUBLIC_SDK_PACKAGES = ["core", "http", "security", "dispatch", "channels", "channels-client", "react-channels", "frontend-client", "frontend-react"];
export const PROPRIETARY_PACKAGES = ["cli", "deploy", "frontend", "infra"];

export const RULES = [
  // ---- E: restricted (checked first so nothing below can re-admit it)
  rule("E", "E-fixtures", /(^|\/)fixtures(\/|$)/i, "internal validation applications and contracts"),
  rule("E", "E-source-map", /\.map$/i, "source maps expose original structure and sometimes source"),
  rule("E", "E-tsbuildinfo", /\.tsbuildinfo$/i, "incremental build state"),
  rule("E", "E-env", /(^|\/)\.env(\..*)?$/i, "environment files"),
  rule("E", "E-keys", /(^|\/)id_(rsa|ed25519|ecdsa)$|\.(?:key|p12|pfx|jks|keystore)$|(?<!\.public)\.pem$/i, "private key and certificate stores"),
  rule("E", "E-vcs", /(^|\/)\.git(\/|$)|(^|\/)\.svn(\/|$)|(^|\/)\.pso(\/|$)/i, "version control and local PSO state"),
  rule("E", "E-logs-db", /\.(?:log|sqlite3?|mv\.db|bak|dump)$/i, "logs, databases, backups"),
  rule("E", "E-internal-docs", /(^|\/)docs\/implementation(\/|$)|(^|\/)evidence(\/|$)/i, "internal reports and evidence"),
  rule("E", "E-sources-jar", /-sources\.jar$|-javadoc\.jar$/i, "Java sources and javadoc (not part of the binary distribution)"),
  rule("E", "E-ai-context", /(^|\/)(CLAUDE\.md|AGENTS\.md|\.claude(\/|$)|\.codex(\/|$))/i, "AI assistant context"),
  rule("E", "E-tests", new RegExp(`^${P}[^/]+/(test|tests|src)(/|$)`), "tests and original TypeScript sources"),
  rule("E", "E-os-junk", /(^|\/)(Thumbs\.db|\.DS_Store|desktop\.ini)$/i, "operating system metadata"),
  rule("E", "E-maven-bookkeeping", /(^|\/)(_remote\.repositories|resolver-status\.properties|[^/]*\.lastUpdated)$/, "Maven bookkeeping of the machine that built the repository"),
  rule("E", "E-psopkg", /\.psopkg$/i, "a package never belongs inside a package"),

  // ---- M: installation metadata
  rule("M", "M-launcher", /^bin\/pso\.cmd$/, "PATH shim"),
  rule("M", "M-licenses", /^licenses\/(LICENSE|NOTICE)$/, "PSO Web Framework license (Apache-2.0) and NOTICE"),

  // ---- A: framework implementation (engines; the source is in the Apache-2.0 repository)
  rule("A", "A-cli-dist", new RegExp(`^${P}cli/(dist|bin)/`), "CLI engine, discovery, release, policy"),
  rule("A", "A-cli-manifest", new RegExp(`^${P}cli/package\\.json$`), "CLI package manifest"),
  rule("A", "A-cli-studio", new RegExp(`^${P}cli/studio/`), "Studio frontend assets (browser-delivered: observable by design)"),
  rule("A", "A-deploy", new RegExp(`^${P}deploy/(dist|agent)/|^${P}deploy/package\\.json$`), "deployment engine and agent"),
  rule("A", "A-infra", new RegExp(`^${P}infra/dist/|^${P}infra/package\.json$`), "infrastructure engine (contract, plan/apply, certificates, identity, compose)"),
  rule("A", "A-frontend-engine", new RegExp(`^${P}frontend/(dist|bin)/|^${P}frontend/package\\.json$`), "FEI/MEI engine, release and nginx tooling"),

  // ---- C: developer-owned source (templates become the developer's code)
  rule("C", "C-templates", new RegExp(`^${P}cli/templates/`), "project templates"),
  rule("C", "C-doc-examples", new RegExp(`^${P}cli/docs/examples/`), "documentation examples"),

  // ---- D: public documentation
  rule("D", "D-docs", new RegExp(`^${P}cli/docs/`), "documentation sources rendered by the portal"),
  rule("D", "D-diagnostic-codes", new RegExp(`^${P}cli/diagnostic-codes\\.json$`), "stable diagnostic codes for the reference (generated at build time)"),
  rule("D", "D-portal", new RegExp(`^${P}cli/portal/`), "documentation portal assets"),

  // ---- B: public SDK
  ...PUBLIC_SDK_PACKAGES.flatMap((p) => [
    rule("B", `B-${p}-dist`, new RegExp(`^${P}${p}/dist/`), `public SDK runtime and declarations: ${p}`),
    rule("B", `B-${p}-manifest`, new RegExp(`^${P}${p}/package\\.json$`), `public SDK manifest: ${p}`),
  ]),
  rule("B", "B-frontend-react-styles", new RegExp(`^${P}frontend-react/styles/`), "public design tokens and shell styles"),

  // ---- B (Java): compiled PSO artifacts of the Maven repository that `pso java:install` copies to ~/.m2. Sources and javadoc jars are E rules above.
  rule("B", "B-java-artifacts", /^maven-repository\/com\/pso\/.+\.(jar|pom|module|md5|sha1|sha256|sha512)$/, "compiled PSO Java starters, BOM and API (no sources)"),
  rule("B", "B-java-metadata", /^maven-repository\/com\/pso\/.+\/maven-metadata[^/]*\.xml(\.(md5|sha1|sha256|sha512))?$/, "Maven repository metadata"),

  // ---- T: third-party runtime (unmodified; licences retained)
  rule("T", "T-third-party", /^node_modules\/(highlight\.js|marked|lucide-static|typescript|reflect-metadata|ws|jose)\//, "third-party runtime dependency"),
];

/** @returns {{cls:string,id:string,note:string}|null} null = UNKNOWN (fails the gate) */
export function classify(stagePath) {
  for (const r of RULES) if (r.re.test(stagePath)) return { cls: r.cls, id: r.id, note: r.note };
  return null;
}

/** Third-party packages must ship a licence file; this is checked by the staging step. */
export const THIRD_PARTY = ["highlight.js", "marked", "lucide-static", "typescript", "reflect-metadata", "ws", "jose"];
