package com.pso.spring.http;

import java.util.List;

/** When the caller's bearer token may be sent to a remote service. Pure and side-effect free so it can be tested without a network. */
final class BearerPolicy {

    private BearerPolicy() {
    }

    /** @return null when forwarding is allowed, otherwise the reason it is refused (never contains the token) */
    static String refusal(boolean secureTransport, String requiredAudience, List<String> tokenAudiences) {
        if (!secureTransport) {
            return "plain http to another host";
        }
        if (requiredAudience != null && !tokenAudiences.contains(requiredAudience)) {
            return "the token's audience does not include \"" + requiredAudience + "\"";
        }
        return null;
    }
}
