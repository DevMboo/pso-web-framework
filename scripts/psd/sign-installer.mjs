// Kept for its documented command line: signs ONE finished file with Authenticode and verifies it, through scripts/psd/codesign.mjs (the same
// identity providers, SHA-256, RFC 3161 timestamp and verification). The release pipeline does not use it: build-release.mjs signs the
// installer and its uninstaller inside the Inno Setup compilation, before any checksum or manifest is computed.
//
//   node scripts/psd/sign-installer.mjs --file <setup.exe> --publisher "<certificate common name>" [--verify-only]
// Without a signing identity or signtool.exe it exits 3 (BLOCKED) and signs nothing.
import { basename, resolve } from "node:path";
import { Blocked, judgeExecutable, signFile } from "./codesign.mjs";
import { readAuthenticode } from "./tools/authenticode.ts";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const file = flag("file") && resolve(flag("file")), publisher = flag("publisher");
if (!file || !publisher) { console.error("usage: sign-installer.mjs --file <setup.exe> --publisher <certificate common name> [--verify-only]"); process.exit(2); }
try {
  if (!argv.includes("--verify-only")) signFile(file, publisher);
  const j = judgeExecutable(basename(file), readAuthenticode(file), publisher);
  console.log(`${j.ok ? "VERIFIED" : "REFUSED "} ${file}: ${j.reason}`);
  process.exit(j.ok ? 0 : 1);
} catch (e) {
  console.error(`${e instanceof Blocked ? "BLOCKED" : "ERROR"}: ${e.message}. Nothing was signed and no substitute is used.`);
  process.exit(e instanceof Blocked ? 3 : 1);
}
