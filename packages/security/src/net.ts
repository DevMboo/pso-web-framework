import { isIP } from "node:net";

/**
 * The private-network ranges an explicitly approved identity provider may live in: 10/8, 172.16/12, 192.168/16 and IPv6 unique-local
 * (fc00::/7). Nothing else: loopback, link-local and the metadata endpoint, CGNAT, multicast and reserved ranges are not "private
 * network" addresses and stay blocked whatever is approved.
 */
export function isPrivateNetworkAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(addr);
  if (kind === 4) { const [a, b] = v4(addr)!; return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168); }
  if (kind === 6 && !addr.includes(".")) return (parseInt(addr.split(":")[0] || "0", 16) & 0xfe00) === 0xfc00;
  return false;
}

const v4 = (ip: string): number[] | undefined => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : undefined;
};

export const isLoopbackHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || (isIP(h) === 4 && v4(h)?.[0] === 127);
};

/**
 * True for addresses a JWKS fetch must never reach: private, loopback (unless explicitly allowed in development),
 * link-local (including the 169.254.169.254 cloud metadata endpoint), shared/CGNAT, benchmarking, multicast, reserved,
 * unspecified, unique-local and IPv4-mapped forms of any of these.
 */
export function isBlockedAddress(ip: string, allowLoopback = false, allowPrivate = false): boolean {
  if (allowPrivate && isPrivateNetworkAddress(ip)) return false;
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(addr);
  if (kind === 4) {
    const [a, b] = v4(addr)!;
    if (a === 127) return !allowLoopback;
    return a === 0 || a === 10 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a! >= 224;
  }
  if (kind === 6) {
    if (addr === "::1") return !allowLoopback;
    if (addr === "::" ) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (mapped) return isBlockedAddress(mapped[1]!, allowLoopback);
    const first = parseInt(addr.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || addr.startsWith("2001:db8");
  }
  return true; // not an IP: callers must resolve names first
}
