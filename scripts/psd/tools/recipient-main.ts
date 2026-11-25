// pso-recipient: the developer's own key provisioning utility (single file, readable on purpose so it can be audited before it touches a private key).
// It needs only Node.js 24+. It never sends anything anywhere and has no network code.
import { existsSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { RecipientError, createIdentity, defaultStoreDir, describeIdentity, exportBackup, groupFingerprint, identityExists, loadPrivateKeyPem, normalizeFingerprint, pinSigner, pinnedSigners, restoreBackup, unpinSigner } from "../../../packages/cli/src/recipient-store.ts";

const VERSION = "0.1.0";
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : "true"; };
const has = (n: string): boolean => argv.includes(`--${n}`);
const json = has("json");
const out = (human: string, data: unknown): void => { console.log(json ? JSON.stringify(data, null, 2) : human); };
const dirFlag = (): { dir?: string } => { const d = flag("store-dir"); return d ? { dir: resolve(d) } : {}; };

const USAGE = `pso-recipient ${VERSION} - create and manage YOUR recipient key for PSO Web installers

  init --label <name> [--store dpapi|passphrase] [--out <dir>]   create a key pair locally; writes <label>.enrollment.json (public only)
  show                                                          fingerprint and protection of your identity (never the private key)
  pin-signer --fingerprint <64 hex> [--label <name>]            trust a PSO signing key you received from the maintainer out of band
  unpin-signer --fingerprint <64 hex>                           stop trusting a signing key (after the maintainer retired it)
  signers                                                       list the signing keys you trust (no identity needed)
  backup --out <file>                                         passphrase-protected backup of the private key (recovery)
  restore --file <backup> [--store dpapi|passphrase] [--force]  restore a backup (new account, new machine)
  doctor                                                        check DPAPI for the account you are running as
Environment: PSO_RECIPIENT_HOME (store directory), PSO_RECIPIENT_PASSPHRASE, PSO_RECIPIENT_BACKUP_PASSPHRASE (non-interactive use).
The private key never leaves this machine. Send the maintainer only the .enrollment.json file, and tell them the fingerprint by another channel.`;

function readSecretSync(prompt: string): string {
  if (!process.stdin.isTTY) throw new RecipientError("PASSPHRASE_REQUIRED", `${prompt.trim()} - no terminal is attached: set the matching environment variable`);
  process.stdout.write(prompt);
  const buf = Buffer.alloc(1); let s = "";
  process.stdin.setRawMode?.(true);
  try {
    // synchronous read, character by character, without echo
    for (;;) {
      let n = 0;
      try { n = readSync(0, buf, 0, 1, null); } catch { n = 0; }
      if (n === 0) break;
      const c = buf.toString("utf8");
      if (c === "\n" || c === "\r") break;
      if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
      if (c === "\u007f" || c === "\b") s = s.slice(0, -1); else s += c;
    }
  } finally { process.stdin.setRawMode?.(false); process.stdout.write("\n"); }
  return s;
}

function passphrase(envName: string, prompt: string, confirm = false): string {
  const e = process.env[envName];
  if (e) return e;
  const a = readSecretSync(prompt);
  if (confirm && readSecretSync("Repeat it: ") !== a) throw new RecipientError("PASSPHRASE_MISMATCH", "the two passphrases differ");
  return a;
}

function isElevated(): boolean {
  if (process.platform !== "win32") return typeof process.getuid === "function" && process.getuid() === 0;
  const r = spawnSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe"), ["/groups"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return /S-1-16-12288/.test(r.stdout ?? "");
}

function main(): number {
  switch (cmd) {
    case "init": {
      const label = flag("label");
      if (!label || label === "true") throw new RecipientError("LABEL_REQUIRED", "--label <name> is required (for example your name or team)");
      const store = (flag("store") ?? (process.platform === "win32" ? "dpapi" : "passphrase")) as "dpapi" | "passphrase";
      if (store !== "dpapi" && store !== "passphrase") throw new RecipientError("STORE_INVALID", "--store must be dpapi or passphrase");
      const r = createIdentity({ label, store, ...(store === "passphrase" ? { passphrase: passphrase("PSO_RECIPIENT_PASSPHRASE", "Choose a passphrase (12+ characters): ", true) } : {}), ...dirFlag(), ...(has("force") ? { force: true } : {}) });
      const outDir = resolve(flag("out") ?? process.cwd());
      const file = join(outDir, `${label.replace(/[^A-Za-z0-9._-]+/g, "_")}.enrollment.json`);
      if (existsSync(file)) throw new RecipientError("ENROLLMENT_EXISTS", `${file} already exists`);
      writeFileSync(file, JSON.stringify({ schema: 1, kind: "pso-recipient-enrollment", label: r.label, keyId: r.keyId, fingerprint: r.fingerprint, publicKeyPem: r.publicKeyPem, createdAt: new Date().toISOString(), tool: `pso-recipient ${VERSION}` }, null, 2));
      out([
        `Identity created (${r.store}) in ${r.dir}`,
        `Public enrollment file: ${file}`,
        `Fingerprint (SHA-256 of your public key):`,
        `  ${groupFingerprint(r.fingerprint)}`,
        ``,
        `Next: send ONLY the enrollment file to the PSO maintainer, and read this fingerprint to them over a different channel (a call, a message app).`,
        `The private key stays on this machine${r.store === "dpapi" ? ` and can only be opened by this Windows account (${userInfo().username})` : ", protected by your passphrase"}.`,
        `Recommended now: pso-recipient backup --out <file> (keep the backup and its passphrase separate).`,
      ].join("\n"), { ...r, enrollmentFile: file });
      return 0;
    }
    case "show": {
      const d = describeIdentity(dirFlag().dir);
      out([`label:        ${d.label}`, `store:        ${d.store}${d.user ? ` (user ${d.user} on ${d.machine || "this machine"})` : ""}`, `key id:       ${d.keyId}`, `fingerprint:  ${groupFingerprint(d.fingerprint)}`, `pinned signers: ${d.pinnedSigners.length ? d.pinnedSigners.map((p) => `${p.label} ${groupFingerprint(p.fingerprint)}`).join("; ") : "none (the installer will ask you to confirm the signer's fingerprint each time)"}`].join("\n"), d);
      return 0;
    }
    case "pin-signer": {
      const fp = flag("fingerprint");
      if (!fp || fp === "true") throw new RecipientError("FINGERPRINT_REQUIRED", "--fingerprint <64 hex characters> is required");
      const p = pinSigner({ fingerprint: fp, label: flag("label") ?? "PSO release signer", ...dirFlag() });
      out(`pinned signer ${groupFingerprint(p.fingerprint)} (${p.label}). Installers signed by any other key are refused.`, p);
      return 0;
    }
    case "unpin-signer": {
      const fp = flag("fingerprint");
      if (!fp || fp === "true") throw new RecipientError("FINGERPRINT_REQUIRED", "--fingerprint <64 hex characters> is required");
      const removed = unpinSigner({ fingerprint: fp, ...dirFlag() });
      out(removed ? `signer ${groupFingerprint(normalizeFingerprint(fp))} is no longer trusted. Installers signed by it are refused again.` : "that signer was not pinned; nothing changed", { removed });
      return 0;
    }
    case "signers": {
      const list = pinnedSigners(dirFlag().dir);
      out(list.length ? list.map((p) => `${groupFingerprint(p.fingerprint)}  ${p.label}  (pinned ${p.pinnedAt})`).join("\n") : "no pinned signers: the installer asks you to confirm the signer's fingerprint every time (or refuses in silent mode without /SIGNER=)", { pinnedSigners: list });
      return 0;
    }
    case "backup": {
      const o = flag("out");
      if (!o || o === "true") throw new RecipientError("OUT_REQUIRED", "--out <file> is required");
      const r = exportBackup({ out: resolve(o), passphrase: passphrase("PSO_RECIPIENT_BACKUP_PASSPHRASE", "Backup passphrase (12+ characters): ", true), ...dirFlag(), ...(process.env["PSO_RECIPIENT_PASSPHRASE"] ? { unlockPassphrase: process.env["PSO_RECIPIENT_PASSPHRASE"] } : {}) });
      out(`backup written to ${r.out} (fingerprint ${groupFingerprint(r.fingerprint)}). Store it and its passphrase in different places.`, r);
      return 0;
    }
    case "restore": {
      const f = flag("file");
      if (!f || f === "true") throw new RecipientError("FILE_REQUIRED", "--file <backup> is required");
      const store = (flag("store") ?? (process.platform === "win32" ? "dpapi" : "passphrase")) as "dpapi" | "passphrase";
      const r = restoreBackup({ file: resolve(f), passphrase: passphrase("PSO_RECIPIENT_BACKUP_PASSPHRASE", "Backup passphrase: "), store, ...(store === "passphrase" ? { newPassphrase: passphrase("PSO_RECIPIENT_PASSPHRASE", "New passphrase for this machine (12+ characters): ", true) } : {}), ...dirFlag(), ...(has("force") ? { force: true } : {}) });
      out(`restored identity ${groupFingerprint(r.fingerprint)} (${r.store}). Releases encrypted for this key can be installed again.`, r);
      return 0;
    }
    case "doctor": {
      const elevated = isElevated();
      const r: Record<string, unknown> = { account: userInfo().username, machine: process.env["COMPUTERNAME"] ?? "", elevated, store: defaultStoreDir(), identity: identityExists(defaultStoreDir()) };
      let dpapi = "not tested";
      try {
        const probe = createIdentity({ dir: join(process.env["TEMP"] ?? ".", `pso-recipient-doctor-${process.pid}`), label: "doctor", store: "dpapi" });
        loadPrivateKeyPem({ dir: probe.dir });
        dpapi = "works for this account";
        try { rmSync(probe.dir, { recursive: true, force: true }); } catch { /* temp */ }
      } catch (e) { dpapi = `FAILED: ${(e as Error).message}`; }
      r["dpapi"] = dpapi;
      out([`account:   ${r["account"]}${elevated ? "  (ELEVATED session)" : ""}`, `DPAPI:     ${dpapi}`, `identity:  ${r["identity"] ? "present" : "not created yet"} (${r["store"]})`, elevated ? "note: a key protected by your normal account cannot be opened from an elevated session of a DIFFERENT account. Run the installer as the account that created the key." : ""].filter(Boolean).join("\n"), r);
      return dpapi.startsWith("FAILED") ? 1 : 0;
    }
    case "version": case "--version": console.log(VERSION); return 0;
    default: console.log(USAGE); return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
  }
}

try { process.exitCode = main(); }
catch (e) {
  if (e instanceof RecipientError) { console.error(`error: ${e.code}: ${e.message}`); process.exitCode = 1; }
  else throw e;
}
