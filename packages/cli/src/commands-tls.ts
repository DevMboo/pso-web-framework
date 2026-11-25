import { X509Certificate } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDevCertificate, describeCertificate, type ServiceDecl, type WorkspaceConfig } from "@pso/core";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command, type Ctx } from "./commands.ts";

/**
 * TLS material of a workspace, in one layout whoever issued it:
 *
 *   tls/ca.crt                 the certificate authority the orchestrator trusts for its upstreams
 *   tls/<service>/tls.crt      the service's certificate (its DNS name in the deployment must be a subject alternative name)
 *   tls/<service>/tls.key      the service's private key
 *   tls/<service>/ca.crt       the same authority, next to the service (its own health check and its trust of an internal issuer)
 *
 * `pso tls:init --dev` fills it with DEVELOPMENT certificates from an authority created on this machine. For production the same
 * files come from the organisation's certificate authority; PSO never generates, ships or reuses production keys. `pso tls:check`
 * verifies whatever is there. The generated docker-compose.yml mounts this directory (PSO_TLS_DIR) read-only.
 */
export const TLS_DIR = "tls";
const README = `DEVELOPMENT CERTIFICATES. NOT FOR PRODUCTION.

Created by \`pso tls:init --dev\` on this machine, for local stacks and tests. The private keys in this directory have no passphrase
and the certificate authority exists only here. They are readable by their owner only (mode 0600 where the file system has modes):
  - Linux: a container reads a mounted key only when it runs as the user that owns it. The generated docker-compose.yml runs every
    container as PSO_CONTAINER_USER; set it in .env to the owner of this directory: PSO_CONTAINER_USER=$(id -u):$(id -g)
  - Windows and macOS (Docker Desktop): modes are not carried into the container; the directory's own access control applies.

For production, replace the files with certificates issued by your own certificate authority, in the same layout:
  ca.crt                the authority the orchestrator trusts for its upstreams
  <service>/tls.crt     the service's certificate; its DNS name in the deployment must be a subject alternative name
  <service>/tls.key     the service's private key
  <service>/ca.crt      the authority, next to the service
or point PSO_TLS_DIR at a directory that has them. Check either with \`pso tls:check\`. Never commit this directory.
`;

const upstreams = (config: WorkspaceConfig): ServiceDecl[] => config.services.filter((s) => s.role !== "orchestrator");
const dirOf = (root: string, ctx: Ctx): string => { const d = str(ctx.flags["dir"]) ?? TLS_DIR; if (/(^|[\\/])\.\.([\\/]|$)/.test(d)) throw new CliError("--dir must stay inside the workspace"); return join(root, ...d.split(/[\\/]/)); };
const read = (f: string): string | undefined => { try { return readFileSync(f, "utf8"); } catch { return undefined; } };

export interface TlsFinding { subject: string; severity: "error" | "warning"; message: string }
export interface TlsRow { name: string; names: string[]; notAfter: string; daysLeft: number; issuer: string }
/** Verifies the TLS directory against the workspace: files present, chain, validity window, key, and the name clients will verify. */
export function checkTlsDir(dir: string, hosts: readonly string[], now = new Date()): { rows: TlsRow[]; findings: TlsFinding[] } {
  const findings: TlsFinding[] = [];
  const rows: TlsRow[] = [];
  const bad = (subject: string, message: string): void => { findings.push({ subject, severity: "error", message }); };
  const caPem = read(join(dir, "ca.crt"));
  let ca: X509Certificate | undefined;
  if (!caPem) bad("ca.crt", "the certificate authority file is missing");
  else {
    try {
      ca = new X509Certificate(caPem);
      const f = describeCertificate(caPem, undefined, now);
      rows.push({ name: "ca.crt", names: [], notAfter: f.notAfter.toISOString(), daysLeft: f.daysLeft, issuer: f.issuer });
      if (/PRIVATE KEY/.test(caPem)) bad("ca.crt", "contains a private key; only the certificate belongs in it");
      if (!f.ca) bad("ca.crt", "is not a certificate authority (basicConstraints CA is not set)");
      if (f.expired) bad("ca.crt", `expired on ${f.notAfter.toISOString().slice(0, 10)}`);
      else if (f.notYetValid) bad("ca.crt", `is not valid before ${f.notBefore.toISOString().slice(0, 10)}`);
      else if (f.daysLeft < 30) findings.push({ subject: "ca.crt", severity: "warning", message: `expires in ${f.daysLeft} day(s)` });
    } catch { bad("ca.crt", "is not a PEM certificate"); }
  }
  for (const host of hosts) {
    const certPem = read(join(dir, host, "tls.crt")), keyPem = read(join(dir, host, "tls.key")), localCa = read(join(dir, host, "ca.crt"));
    if (!certPem) { bad(host, `${host}/tls.crt is missing`); continue; }
    if (!keyPem) { bad(host, `${host}/tls.key is missing`); continue; }
    try {
      const f = describeCertificate(certPem, keyPem, now);
      const leaf = new X509Certificate(certPem);
      rows.push({ name: host, names: f.names, notAfter: f.notAfter.toISOString(), daysLeft: f.daysLeft, issuer: f.issuer });
      if (f.matchesKey !== true) bad(host, "the private key does not belong to the certificate");
      if (f.ca) bad(host, "is a certificate authority, not a server certificate");
      if (f.expired) bad(host, `the certificate expired on ${f.notAfter.toISOString().slice(0, 10)}`);
      else if (f.notYetValid) bad(host, `the certificate is not valid before ${f.notBefore.toISOString().slice(0, 10)}`);
      else if (f.daysLeft < 30) findings.push({ subject: host, severity: "warning", message: `the certificate expires in ${f.daysLeft} day(s)` });
      if (!f.names.includes(host)) bad(host, `the certificate does not name "${host}" (subject alternative names: ${f.names.join(", ") || "none"}); the orchestrator verifies the host name it connects to`);
      if (!f.names.includes("localhost")) findings.push({ subject: host, severity: "warning", message: 'the certificate does not name "localhost": the container health check of the generated compose file connects to https://localhost' });
      if (ca && !(leaf.checkIssued(ca) && leaf.verify(ca.publicKey))) bad(host, "the certificate was not issued by the authority in ca.crt");
      if (!localCa) bad(host, `${host}/ca.crt is missing (a copy of the authority next to the service)`);
      else if (caPem && localCa.trim() !== caPem.trim()) findings.push({ subject: host, severity: "warning", message: `${host}/ca.crt differs from ca.crt` });
    } catch { bad(host, "tls.crt or tls.key is not valid PEM"); }
  }
  return { rows, findings };
}

export const TLS_COMMANDS: Record<string, Command> = {
  "tls:init": {
    usage: "pso tls:init --dev [--days 365] [--hosts name,name] [--dir tls] [--force] [--json]",
    summary: "Create DEVELOPMENT TLS certificates for the workspace's services (a local certificate authority and one certificate per service, named after the service) so a local stack runs with verified TLS. Production certificates are supplied in the same layout, never generated here",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (ctx.flags["dev"] !== true) throw new CliError("tls:init creates development certificates only: pass --dev to say that is what you want", `For production, place certificates from your own certificate authority in ${TLS_DIR}/ (see \`pso tls:check\`) or set PSO_TLS_DIR`);
      const days = Number(str(ctx.flags["days"]) ?? 365);
      if (!Number.isInteger(days) || days < 1 || days > 825) throw new CliError("--days must be a whole number between 1 and 825");
      const extra = (str(ctx.flags["hosts"]) ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      for (const h of extra) if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h)) throw new CliError(`Invalid host name "${h}"`, "Use the DNS name of the container, e.g. idp");
      const hosts = [...new Set([...upstreams(config).map((s) => s.name), ...extra])];
      if (!hosts.length) throw new CliError("The workspace has no service to create a certificate for");
      const dir = dirOf(root, ctx);
      const force = ctx.flags["force"] === true;
      const notAfter = new Date(Date.now() + days * 86_400_000);
      const actions: Array<{ path: string; action: "created" | "unchanged" | "replaced" }> = [];
      mkdirSync(dir, { recursive: true });
      const write = (rel: string, text: string, mode: number): void => { const f = join(dir, ...rel.split("/")); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text, { mode }); try { chmodSync(f, mode); } catch { /* not supported on this file system */ } };

      // the authority: kept when it exists and can still sign (its key is here), so certificates added later share it
      let caCert = read(join(dir, "ca.crt")), caKey = read(join(dir, "ca.key"));
      const caUsable = !!caCert && !!caKey && !describeCertificate(caCert, caKey).expired && describeCertificate(caCert, caKey).matchesKey === true;
      if (!caUsable || force) {
        if (caCert && !caKey && !force) throw new CliError(`${TLS_DIR}/ca.crt exists without its key: these are not development certificates created here`, "Use --dir for a separate directory, or --force to replace everything in it");
        const ca = createDevCertificate({ commonName: `PSO development CA for ${config.name} - not for production`, ca: true, notAfter: new Date(Date.now() + Math.max(days, 365) * 86_400_000) });
        actions.push({ path: "ca.crt", action: caCert ? "replaced" : "created" });
        caCert = ca.certPem; caKey = ca.keyPem;
        write("ca.crt", caCert, 0o644); write("ca.key", caKey, 0o600);
      } else actions.push({ path: "ca.crt", action: "unchanged" });
      const issuer = { certPem: caCert!, keyPem: caKey! };
      const renewed = actions[0]!.action !== "unchanged";
      for (const host of hosts) {
        const current = checkTlsDir(dir, [host]).findings.filter((f) => f.subject === host && f.severity === "error");
        const had = existsSync(join(dir, host, "tls.crt"));
        if (had && !current.length && !renewed && !force) { actions.push({ path: `${host}/tls.crt`, action: "unchanged" }); continue; }
        const leaf = createDevCertificate({ commonName: host, names: [host, "localhost"], issuer, notAfter });
        // Private keys are readable by their owner only. A container reads the mounted key because the generated compose file runs it
        // as that owner (PSO_CONTAINER_USER); on file systems without POSIX modes the directory's access control is what applies.
        write(`${host}/tls.crt`, leaf.certPem, 0o644); write(`${host}/tls.key`, leaf.keyPem, 0o600); write(`${host}/ca.crt`, caCert!, 0o644);
        actions.push({ path: `${host}/tls.crt`, action: had ? "replaced" : "created" });
      }
      write("README.txt", README, 0o644);
      // development keys never belong in version control
      const ignore = join(root, ".gitignore");
      const rel = (str(ctx.flags["dir"]) ?? TLS_DIR).replace(/\\/g, "/").replace(/\/$/, "");
      if (!(read(ignore) ?? "").split(/\r?\n/).some((l) => l.trim() === `${rel}/` || l.trim() === rel)) appendFileSync(ignore, `${existsSync(ignore) && !(read(ignore) ?? "").endsWith("\n") ? "\n" : ""}${rel}/\n`);
      emit(ctx, { directory: rel, development: true, notAfter: notAfter.toISOString(), hosts, files: actions }, [
        ...actions.map((a) => `${a.action.padEnd(10)} ${rel}/${a.path}`),
        `DEVELOPMENT certificates for ${hosts.join(", ")} (valid ${days} days; names: <service>, localhost). Not for production: see ${rel}/README.txt`,
        "Next: pso docker:init   (the generated compose file mounts this directory and uses TLS between the orchestrator and the services)",
      ].join("\n"));
      return 0;
    },
  },

  "tls:check": {
    usage: "pso tls:check [--dir tls] [--hosts name,name] [--json]",
    summary: "Verify the workspace's TLS material: files, issuing authority, validity dates, private keys and the host names the orchestrator will verify (exit 1 on any problem; no key material is printed)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const dir = dirOf(root, ctx);
      const extra = (str(ctx.flags["hosts"]) ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      const hosts = [...new Set([...upstreams(config).map((s) => s.name), ...extra])];
      if (!existsSync(dir)) throw new CliError(`No TLS directory (${str(ctx.flags["dir"]) ?? TLS_DIR}/)`, "Development: `pso tls:init --dev`. Production: place your certificates there (ca.crt, <service>/tls.crt, <service>/tls.key, <service>/ca.crt)");
      const { rows, findings } = checkTlsDir(dir, hosts);
      const errors = findings.filter((f) => f.severity === "error");
      emit(ctx, { ok: errors.length === 0, certificates: rows, findings }, [
        ...rows.map((r) => `${r.name.padEnd(16)} expires ${r.notAfter.slice(0, 10)} (${r.daysLeft} days)${r.names.length ? `  names: ${r.names.join(", ")}` : ""}  issuer: ${r.issuer}`),
        ...findings.map((f) => `${f.severity === "error" ? "ERROR  " : "WARNING"} ${f.subject}: ${f.message}`),
        errors.length ? `FAILED: ${errors.length} problem(s)` : "OK",
      ].join("\n"));
      return errors.length ? 1 : 0;
    },
  },
};
