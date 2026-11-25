package com.pso.spring.security;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Where the signing keys may be fetched from. The JWKS URI is configuration, but configuration is also what an attacker changes
 * first, and a service that fetches a URL on a private network on behalf of its configuration is a way into that network. The rule
 * is the one the TypeScript orchestrator applies ({@code security.authentication.jwks.privateHosts}):
 * <ul>
 *   <li>an endpoint that is, or resolves to, a private, link-local (this includes the cloud metadata address), shared, reserved,
 *       multicast or unspecified address is refused;</li>
 *   <li>unless it is approved by naming it exactly: {@code pso.security.jwt.private-hosts} lists {@code host:port} entries, and only
 *       the JWKS URI itself, over https, on exactly that host and port, is covered. It is an approval of one endpoint, not a switch
 *       for private networks: there are no wildcards;</li>
 *   <li>loopback stays allowed (an identity provider on the developer's machine), as before;</li>
 *   <li>redirects are never followed, so an approved or public endpoint cannot send the request somewhere else.</li>
 * </ul>
 * The address is checked when the service starts (when the name resolves) and again before every JWKS request. Unlike the
 * orchestrator, the connection is not pinned to the address that was checked: the JDK client resolves the name again.
 */
final class JwksAccessPolicy {

    private static final Pattern HOST_PORT = Pattern.compile("^(\\[[0-9a-f:]+\\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?):\\d{1,5}$");
    static final String HOW = "an identity provider on a private network must be approved explicitly: pso.security.jwt.private-hosts"
        + " (PSO_JWT_JWKS_PRIVATE_HOSTS) = host:port of the JWKS URI";

    private JwksAccessPolicy() {
    }

    /** Problems of the approval list itself: every entry must be {@code host:port}. */
    static List<String> listProblems(List<String> privateHosts) {
        List<String> out = new ArrayList<>();
        for (String raw : privateHosts) {
            String a = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
            if (!a.isEmpty() && !HOST_PORT.matcher(a).matches()) {
                out.add("pso.security.jwt.private-hosts: \"" + (a.length() > 80 ? a.substring(0, 80) : a)
                    + "\" is not host:port (the port is required; wildcards, schemes and paths are not accepted)");
            }
        }
        return out;
    }

    /** True when the JWKS URI is https and its exact host:port is on the approval list. */
    static boolean approved(URI jwks, List<String> privateHosts) {
        if (!"https".equalsIgnoreCase(jwks.getScheme()) || jwks.getHost() == null) {
            return false;
        }
        int port = jwks.getPort() < 0 ? 443 : jwks.getPort();
        String want = jwks.getHost().toLowerCase(Locale.ROOT) + ":" + port;
        for (String raw : privateHosts) {
            if (raw != null && raw.trim().toLowerCase(Locale.ROOT).equals(want)) {
                return true;
            }
        }
        return false;
    }

    /** Private, link-local, shared (CGNAT), benchmarking, documentation, multicast, reserved and unspecified addresses. Loopback is not blocked. */
    static boolean blocked(InetAddress a) {
        if (a.isLoopbackAddress()) {
            return false;
        }
        if (a.isAnyLocalAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isMulticastAddress()) {
            return true;
        }
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) {
            int b0 = b[0] & 0xff;
            int b1 = b[1] & 0xff;
            return b0 == 0 || (b0 == 100 && b1 >= 64 && b1 <= 127) || (b0 == 192 && b1 == 0) || (b0 == 198 && (b1 == 18 || b1 == 19)) || b0 >= 224;
        }
        if (a instanceof Inet6Address) {
            int first = ((b[0] & 0xff) << 8) | (b[1] & 0xff);
            // unique local fc00::/7, documentation 2001:db8::/32, IPv4-translated 64:ff9b::/96 (checked through its embedded address)
            if ((first & 0xfe00) == 0xfc00 || (first == 0x2001 && (b[2] & 0xff) == 0x0d && (b[3] & 0xff) == 0xb8)) {
                return true;
            }
            if (first == 0x0064 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b) {
                try {
                    return blocked(InetAddress.getByAddress(new byte[] { b[12], b[13], b[14], b[15] }));
                } catch (UnknownHostException e) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * The reason the endpoint may not be contacted, or null. A name that does not resolve is not a reason: the request will fail
     * by itself and the identity provider may simply not be up yet.
     */
    static String refusal(URI jwks, boolean approved) {
        if (approved) {
            return null;
        }
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(jwks.getHost());
        } catch (UnknownHostException e) {
            return null;
        }
        for (InetAddress a : addresses) {
            if (blocked(a)) {
                return "the JWKS host is, or resolves to, a private, link-local, metadata or otherwise blocked address (" + HOW + ")";
            }
        }
        return null;
    }
}
