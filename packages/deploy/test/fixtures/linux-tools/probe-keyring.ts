// Runs INSIDE the linux-tools container, on a private D-Bus session with an unlocked gnome-keyring (see linux-tools.test.ts).
import { CredentialStoreError, SecretServiceProvider, resolveCredentialProvider } from "/src/src/credentials.ts";

const out: Record<string, unknown> = {};
const p = resolveCredentialProvider({ home: "/tmp/pso-cloud", env: {}, platform: "linux" });
out["provider"] = p.id;
out["availability"] = new SecretServiceProvider().availability();
const secrets: Record<string, string> = { "cred_plain": "s3cret-value", "cred_unicode.1": "pässwörd ✓ with spaces", "cred:multi-line": "line one\nline two\n", "cred_quotes": `it's "quoted" $HOME \`x\`` };
const roundTrip: Record<string, boolean> = {};
for (const [ref, v] of Object.entries(secrets)) { p.set(ref, v); roundTrip[ref] = p.get(ref) === v; }
out["roundTrip"] = roundTrip;
p.set("cred_plain", "rotated"); out["overwrite"] = p.get("cred_plain") === "rotated";
out["removed"] = p.remove("cred_plain"); out["afterRemove"] = p.get("cred_plain") ?? null;
out["missing"] = p.get("cred_never_stored") ?? null;
try { p.set("bad ref; rm -rf /", "x"); out["invalidRef"] = "accepted"; } catch (e) { out["invalidRef"] = e instanceof CredentialStoreError ? "refused" : String(e); }
for (const ref of Object.keys(secrets)) p.remove(ref);
console.log(JSON.stringify(out));
