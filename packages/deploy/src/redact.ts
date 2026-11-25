/**
 * Redaction: the one place that decides what may leave a trusted process boundary as text.
 *
 * Three layers, because none of them is enough alone:
 *   1. exact secrets registered at run time (`registerSecret`): a password that was just typed or read is masked wherever it shows up;
 *   2. key names: any property called password, token, secret, passphrase, private key... is masked in structured data;
 *   3. patterns: PEM private keys, `Authorization` headers, URL userinfo (https://user:token@host), common token shapes.
 * It reduces accidental disclosure; it cannot recognise a secret that has no known shape and was never registered.
 */
const MASK = "[REDACTED]";
const registered = new Set<string>();

/** Registers a literal value that must never be printed. Values shorter than 4 characters are ignored (they would mask ordinary text). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) registered.add(value);
}

const KEY_PATTERN = /(pass(word|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie|signature|verifier)/i;
/** Keys that look secret but only carry a reference or a public fact. */
const KEY_ALLOW = /^(passwordless|credentialStore|credentialVersion|credentials?Ref|credentialRef|secretRef|secretRefs|tokenTtl.*|credentials|passwordAuth|hasPassword|signatureAlgorithm|publicKey.*|.*Fingerprint)$/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(bearer|basic|token)?\s*[^\s,;"']+/gi, "$1: " + MASK],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1$2:" + MASK + "@"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MASK],
  [/\b(pso-enroll-[A-Za-z0-9_-]{20,})\b/g, MASK],
  [/\b((?:password|passwd|passphrase|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1" + MASK],
];

export function redactText(text: string): string {
  let out = text;
  for (const s of registered) out = out.split(s).join(MASK);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** Structured redaction: masks secret-named keys, scrubs every string, bounds depth and size. */
export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactText(v);
  if (v === null || typeof v !== "object") return v;
  if (depth > 12) return "[depth limit]";
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = KEY_PATTERN.test(k) && !KEY_ALLOW.test(k) && x !== null && x !== undefined && typeof x !== "boolean" ? MASK : redactValue(x, depth + 1);
  }
  return out;
}

/** True when a string contains something `redactText` would change: used by validators that must refuse inline secrets. */
export const looksSecret = (text: string): boolean => redactText(text) !== text;

export { MASK as REDACTED };
