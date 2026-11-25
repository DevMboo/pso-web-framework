import { spawnSync } from "node:child_process";
import { existsSync, statSync, chmodSync } from "node:fs";
import { userInfo } from "node:os";

/**
 * Diagnosis and (explicitly authorized) repair of the access rights on the SSH private key file of a connection.
 * OpenSSH refuses a private key that anyone but its owner can read ("UNPROTECTED PRIVATE KEY FILE"). Nothing here reads the key's CONTENT,
 * and nothing is changed without `confirm: true`: a diagnosis never modifies the file, a repair only touches the one path named by the connection.
 */
export type KeyVerdict = "ok" | "too-open" | "missing" | "unknown";
export interface KeyEntry { principal: string; rights: string; safe: boolean }
export interface KeyAccess {
  path: string; platform: "windows" | "posix"; exists: boolean; verdict: KeyVerdict;
  /** who can reach the file (Windows: the ACL; POSIX: the mode bits for group and others) */
  entries: KeyEntry[]; unsafe: string[]; detail: string;
  /** exactly what a repair would run, as display strings; `repair` does nothing else */
  plan: string[];
}

const SAFE_WINDOWS = /^(NT AUTHORITY\\SYSTEM|NT AUTHORITY\\SISTEMA|BUILTIN\\Administrators|BUILTIN\\Administradores|NT SERVICE\\TrustedInstaller)$/i;
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "latin1", windowsHide: true, timeout: 15_000 });
const me = (): { user: string; qualified: string } => { const u = userInfo().username; const dom = process.env["USERDOMAIN"]; return { user: u, qualified: dom ? `${dom}\\${u}` : u }; };

/** Parses `icacls <file>` output into principal / rights pairs. */
export function parseIcacls(out: string, file: string): Array<{ principal: string; rights: string }> {
  const rows: Array<{ principal: string; rights: string }> = [];
  for (const raw of out.split(/\r?\n/)) {
    let line = raw; if (line.startsWith(file)) line = line.slice(file.length);
    line = line.trim(); if (!line || /^Successfully processed|^Processed|^Mapping|^Failed processing/i.test(line)) continue;
    const m = /^(.*?):(\((?:[A-Z0-9,]+|[A-Z]+)\)(?:\([A-Z,]+\))*)\s*$/.exec(line); if (m) rows.push({ principal: m[1]!.trim(), rights: m[2]! });
  }
  return rows;
}

export function inspectKeyFile(path: string, platform: NodeJS.Platform = process.platform): KeyAccess {
  const win = platform === "win32"; const base = { path, platform: win ? "windows" as const : "posix" as const };
  if (!existsSync(path)) return { ...base, exists: false, verdict: "missing", entries: [], unsafe: [], detail: "the key file does not exist at this path", plan: [] };
  if (win) {
    const r = run("icacls", [path]); if (r.status !== 0) return { ...base, exists: true, verdict: "unknown", entries: [], unsafe: [], detail: `could not read the access list: ${(r.stderr || r.stdout || "icacls failed").trim().split("\n")[0]}`, plan: [] };
    const { user, qualified } = me(); const entries = parseIcacls(r.stdout, path).map((e) => ({ ...e, safe: e.principal.toLowerCase() === qualified.toLowerCase() || e.principal.toLowerCase().endsWith(`\\${user.toLowerCase()}`) || e.principal.toLowerCase() === user.toLowerCase() || SAFE_WINDOWS.test(e.principal) }));
    const unsafe = entries.filter((e) => !e.safe).map((e) => e.principal);
    return { ...base, exists: true, verdict: unsafe.length ? "too-open" : "ok", entries, unsafe, detail: unsafe.length ? `besides you, the system and administrators, these principals have access: ${unsafe.join(", ")}` : "only you, the system and administrators have access", plan: unsafe.length ? repairPlanWindows(path, unsafe, qualified) : [] };
  }
  const st = statSync(path); const mode = st.mode & 0o777; const open = mode & 0o077;
  const entries: KeyEntry[] = [{ principal: "owner", rights: (mode >> 6 & 7).toString(8), safe: true }, { principal: "group", rights: (mode >> 3 & 7).toString(8), safe: !(mode & 0o070) }, { principal: "others", rights: (mode & 7).toString(8), safe: !(mode & 0o007) }];
  return { ...base, exists: true, verdict: open ? "too-open" : "ok", entries, unsafe: entries.filter((e) => !e.safe).map((e) => e.principal), detail: open ? `mode ${mode.toString(8)}: group or others can access the key` : `mode ${mode.toString(8)}: only the owner can access the key`, plan: open ? [`chmod 600 ${path}`] : [] };
}

function repairPlanWindows(path: string, _unsafe: string[], qualified: string): string[] {
  // by design independent of how the system localizes account names: reset the list to the inherited defaults, drop inheritance, grant the owner alone
  return [`icacls "${path}" /reset`, `icacls "${path}" /inheritance:r`, `icacls "${path}" /grant:r "${qualified}:(R)"`];
}

export interface RepairResult { repaired: boolean; before: KeyAccess; after: KeyAccess; ran: string[] }
/** Applies exactly `plan` to exactly `path`, only with `confirm: true`; re-reads the file's access afterwards and reports it as measured. */
export function repairKeyFile(path: string, o: { confirm: boolean }, platform: NodeJS.Platform = process.platform): RepairResult {
  const before = inspectKeyFile(path, platform);
  if (!o.confirm) throw new Error("changing the access rights of a private key file needs explicit confirmation");
  if (before.verdict === "missing" || before.verdict === "unknown") throw new Error(`cannot repair: ${before.detail}`);
  if (before.verdict === "ok") return { repaired: false, before, after: before, ran: [] };
  const ran: string[] = [];
  if (before.platform === "windows") {
    const { qualified } = me();
    const steps: string[][] = [[path, "/reset"], [path, "/inheritance:r"], [path, "/grant:r", `${qualified}:(R)`]];
    for (const s of steps) { const r = run("icacls", s); ran.push(`icacls ${s.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`); if (r.status !== 0) throw new Error(`icacls failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`); }
  } else { chmodSync(path, 0o600); ran.push(`chmod 600 ${path}`); }
  return { repaired: true, before, after: inspectKeyFile(path, platform), ran };
}

/** Recognizes what OpenSSH says about a rejected key, so that the user is told the cause and the next step instead of a raw error. */
export function explainSshFailure(stderr: string, connection?: string): { code: "KEY_PERMISSIONS" | "KEY_UNREADABLE" | "KEY_PASSPHRASE"; advice: string } | undefined {
  const next = connection ? `pso connection:key ${connection}` : "pso connection:key <connection>";
  if (/UNPROTECTED PRIVATE KEY FILE|Permissions .* are too open|bad permissions/i.test(stderr)) return { code: "KEY_PERMISSIONS", advice: `OpenSSH refuses the private key because other users can access the file. Diagnose it with \`${next}\`; \`${next} --repair --yes\` restricts the file to you (it changes only that file's access rights, and shows each command first).` };
  if (/no such identity|Load key .*: No such file|invalid format|Load key .*: (?:error|invalid)/i.test(stderr)) return { code: "KEY_UNREADABLE", advice: `OpenSSH could not load the private key file named by the connection. Check the path and the format with \`${next}\`.` };
  if (/incorrect passphrase|passphrase for key|Load key .*: incorrect/i.test(stderr)) return { code: "KEY_PASSPHRASE", advice: "the key is passphrase-protected and the stored passphrase is missing or wrong: store it with `pso connection:rotate` or re-add the connection." };
  return undefined;
}
