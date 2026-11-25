package com.pso.dispatch;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Publisher authentication for Dispatch, identical to the TypeScript runtime (packages/dispatch/src/trust.ts).
 *
 * <p>The envelope's {@code source} is a field any producer can write: on its own it proves nothing. A service that has a signing key adds
 * a transport header to every message it publishes:
 *
 * <pre>x-pso-signature: v1=base64url( HMAC-SHA256( key, channel + "\n" + the exact envelope bytes ) )</pre>
 *
 * A consumer holds the key of each service it trusts and looks the key up BY THE SOURCE THE ENVELOPE CLAIMS, so a service that only has
 * its own key cannot produce a message that verifies under another service's name, and neither the content nor the channel of a message
 * can change without invalidating it.
 *
 * <p>Limits, stated plainly: keys are symmetric (a consumer able to verify a service could also sign as it: give each key only to its
 * service and to the consumers that verify it); a captured, validly signed message can be replayed by someone who can write to the
 * broker (duplicate suppression covers replays inside its retention; broker authentication and ACLs stay the first line of defence).
 * The envelope format is unchanged: a consumer that does not verify simply ignores the header.
 */
public record Trust(Mode mode, String signingKey, Map<String, List<String>> keys) {

    public static final String HEADER = "x-pso-signature";
    public static final int MIN_KEY_LENGTH = 32;
    private static final String SCHEME = "v1=";

    /**
     * OFF: nothing is required or checked (the behaviour before signatures existed). PERMISSIVE: a wrong signature for a source whose key
     * is held is refused; unsigned messages and unknown sources are still handled (and counted). REQUIRED: every consumed message must
     * carry a valid signature of the source it claims; anything else is dead-lettered unprocessed.
     */
    public enum Mode {
        OFF, PERMISSIVE, REQUIRED;

        public static Mode of(String s) {
            return switch (s == null ? "off" : s.trim().toLowerCase()) {
                case "off", "" -> OFF;
                case "permissive" -> PERMISSIVE;
                case "required" -> REQUIRED;
                default -> throw new IllegalArgumentException("pso.dispatch.trust.mode must be one of off, permissive, required");
            };
        }
    }

    public enum Verdict {
        VERIFIED("verified"), UNSIGNED("unsigned"), UNKNOWN_SOURCE("unknown-source"), INVALID("invalid");

        private final String wire;

        Verdict(String wire) {
            this.wire = wire;
        }

        /** the same word the TypeScript runtime writes into the dead-letter reason */
        public String wire() {
            return wire;
        }
    }

    public static final Trust OFF = new Trust(Mode.OFF, null, Map.of());

    public Trust {
        mode = mode == null ? Mode.OFF : mode;
        signingKey = signingKey == null || signingKey.isBlank() ? null : signingKey.trim();
        Map<String, List<String>> copy = new LinkedHashMap<>();
        if (keys != null) {
            keys.forEach((source, list) -> copy.put(source, List.copyOf(list)));
        }
        if (signingKey != null && signingKey.length() < MIN_KEY_LENGTH) {
            throw new IllegalArgumentException("the dispatch signing key must be at least " + MIN_KEY_LENGTH + " characters");
        }
        for (Map.Entry<String, List<String>> e : copy.entrySet()) {
            if (e.getValue().stream().anyMatch(k -> k == null || k.length() < MIN_KEY_LENGTH)) {
                throw new IllegalArgumentException("the dispatch trust key of \"" + e.getKey() + "\" must be at least " + MIN_KEY_LENGTH + " characters"); // never the key itself
            }
        }
        keys = Map.copyOf(copy);
    }

    /** A service always verifies its own messages with its own signing key. */
    public Trust withOwnSource(String source) {
        if (signingKey == null) {
            return this;
        }
        Map<String, List<String>> merged = new LinkedHashMap<>(keys);
        List<String> own = new java.util.ArrayList<>(List.of(signingKey));
        own.addAll(merged.getOrDefault(source, List.of()));
        merged.put(source, own);
        return new Trust(mode, signingKey, merged);
    }

    private static byte[] mac(String key, String channel, byte[] body) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            m.update(channel.getBytes(StandardCharsets.UTF_8));
            m.update((byte) '\n');
            return m.doFinal(body);
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException("HMAC-SHA256 is not available", e);
        }
    }

    public static String sign(String key, String channel, byte[] body) {
        return SCHEME + Base64.getUrlEncoder().withoutPadding().encodeToString(mac(key, channel, body));
    }

    /** The headers to add to a message this service publishes: the signature when a signing key is configured, nothing otherwise. */
    public Map<String, String> headersFor(String channel, byte[] body) {
        return signingKey == null ? Map.of() : Map.of(HEADER, sign(signingKey, channel, body));
    }

    /** Checks the signature header of one received message against the keys held for the source its envelope claims. */
    public Verdict verify(String channel, byte[] body, String header, String claimedSource) {
        if (header == null || header.isEmpty()) {
            return Verdict.UNSIGNED;
        }
        List<String> candidates = keys.get(claimedSource);
        if (candidates == null || candidates.isEmpty()) {
            return Verdict.UNKNOWN_SOURCE;
        }
        if (!header.startsWith(SCHEME) || header.length() > 200) {
            return Verdict.INVALID;
        }
        byte[] got;
        try {
            got = Base64.getUrlDecoder().decode(header.substring(SCHEME.length()));
        } catch (IllegalArgumentException e) {
            return Verdict.INVALID;
        }
        if (got.length != 32) {
            return Verdict.INVALID;
        }
        for (String k : candidates) {
            if (MessageDigest.isEqual(mac(k, channel, body), got)) { // constant time
                return Verdict.VERIFIED;
            }
        }
        return Verdict.INVALID;
    }

    /** {@code PSO_DISPATCH_TRUST_KEY_USERS_SERVICE} names the service {@code users-service} (the same convention as the Node runtime). */
    public static Map<String, List<String>> keysFromEnvironment(Map<String, String> env) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        String prefix = "PSO_DISPATCH_TRUST_KEY_";
        env.forEach((name, value) -> {
            if (!name.startsWith(prefix) || value == null || value.isBlank()) {
                return;
            }
            String source = name.substring(prefix.length()).toLowerCase().replace('_', '-');
            if (!source.matches("^[a-z][a-z0-9]*(-[a-z0-9]+)*$")) {
                throw new IllegalArgumentException(name + " does not name a service (PSO_DISPATCH_TRUST_KEY_<SERVICE>, for example PSO_DISPATCH_TRUST_KEY_USERS_SERVICE)");
            }
            out.put(source, java.util.Arrays.stream(value.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList());
        });
        return out;
    }
}
