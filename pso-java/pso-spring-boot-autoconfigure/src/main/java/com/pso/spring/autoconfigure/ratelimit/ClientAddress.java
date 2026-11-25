package com.pso.spring.autoconfigure.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;

/**
 * The client address used for limiting. {@code X-Forwarded-For} is honoured ONLY when the TCP peer is a configured trusted proxy; the
 * chain is read from the right, skipping trusted hops, so a client cannot choose its identity by prepending values. Identical rules to
 * the TypeScript orchestrator.
 */
public final class ClientAddress {

    private ClientAddress() {
    }

    /** An IP address or CIDR range. Only literals are accepted: no DNS lookup can ever happen here. */
    public record Cidr(byte[] network, int bits) {

        public static Cidr parse(String text) {
            String[] parts = text.trim().split("/", 2);
            byte[] addr = literal(parts[0]);
            if (addr == null) {
                throw new IllegalArgumentException("not an IP address or CIDR: " + (text.length() > 50 ? text.substring(0, 50) : text));
            }
            int max = addr.length * 8;
            int bits = max;
            if (parts.length == 2) {
                if (!parts[1].matches("\\d{1,3}")) {
                    throw new IllegalArgumentException("invalid CIDR prefix in: " + parts[0] + "/" + parts[1]);
                }
                bits = Integer.parseInt(parts[1]);
                if (bits > max) {
                    throw new IllegalArgumentException("CIDR prefix too long in: " + parts[0] + "/" + parts[1]);
                }
            }
            return new Cidr(addr, bits);
        }

        public boolean contains(byte[] candidate) {
            if (candidate == null || candidate.length != network.length) {
                return false;
            }
            int full = bits / 8;
            for (int i = 0; i < full; i++) {
                if (candidate[i] != network[i]) {
                    return false;
                }
            }
            int rest = bits % 8;
            if (rest == 0) {
                return true;
            }
            int mask = 0xFF << (8 - rest) & 0xFF;
            return (candidate[full] & mask) == (network[full] & mask);
        }
    }

    /** Bytes of an IP literal, or null when the text is not one (never resolves names). IPv4-mapped IPv6 is normalised to IPv4. */
    static byte[] literal(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().toLowerCase(Locale.ROOT);
        if (s.startsWith("::ffff:") && s.indexOf('.') > 0) {
            s = s.substring(7);
        }
        boolean v6 = s.indexOf(':') >= 0;
        if (v6 ? !s.matches("[0-9a-f:.]{2,45}") : !s.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
            return null;
        }
        try {
            return InetAddress.getByName(s).getAddress(); // a literal: InetAddress performs no lookup
        } catch (UnknownHostException e) {
            return null;
        }
    }

    private static boolean trusted(List<Cidr> list, byte[] addr) {
        for (Cidr c : list) {
            if (c.contains(addr)) {
                return true;
            }
        }
        return false;
    }

    private static String normalised(String remote) {
        if (remote == null) {
            return "unknown";
        }
        return remote.toLowerCase(Locale.ROOT).startsWith("::ffff:") && remote.indexOf('.') > 0 ? remote.substring(7) : remote;
    }

    public static String resolve(HttpServletRequest req, List<Cidr> trustedProxies) {
        String peer = normalised(req.getRemoteAddr());
        if (trustedProxies.isEmpty() || !trusted(trustedProxies, literal(peer))) {
            return peer;
        }
        List<String> chain = new ArrayList<>();
        Enumeration<String> headers = req.getHeaders("X-Forwarded-For");
        if (headers != null) {
            for (String h : Collections.list(headers)) {
                for (String hop : h.split(",")) {
                    if (!hop.isBlank()) {
                        chain.add(normalised(hop.trim()));
                    }
                }
            }
        }
        for (int i = chain.size() - 1; i >= 0; i--) {
            byte[] hop = literal(chain.get(i));
            if (hop == null) {
                return peer; // garbage in the chain: never guess an identity
            }
            if (!trusted(trustedProxies, hop)) {
                return chain.get(i);
            }
        }
        return peer;
    }
}
