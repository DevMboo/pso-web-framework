package com.pso.spring.http;

import org.springframework.util.ClassUtils;

/**
 * Bridge to Spring Security that stays optional: the caller's bearer token is read from the VERIFIED authentication of the
 * current request (never from a raw header the client could have forged). Without Spring Security on the classpath nothing is forwarded.
 */
final class BearerSource {

    private static final boolean SECURITY = ClassUtils.isPresent("org.springframework.security.core.context.SecurityContextHolder", BearerSource.class.getClassLoader())
        && ClassUtils.isPresent("org.springframework.security.oauth2.jwt.Jwt", BearerSource.class.getClassLoader());

    private BearerSource() {
    }

    static String currentToken() {
        return SECURITY ? Spring.token() : null;
    }

    /** Audiences of the verified token of the current request (empty when there is none). */
    static java.util.List<String> currentAudiences() {
        return SECURITY ? Spring.audiences() : java.util.List.of();
    }

    static Object captureContext() {
        return SECURITY ? Spring.capture() : null;
    }

    static AutoCloseable restore(Object context) {
        return SECURITY ? Spring.restore(context) : () -> { };
    }

    /** Isolated so the Spring Security classes are only loaded when present. */
    private static final class Spring {
        static String token() {
            var auth = org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
            if (auth != null && auth.isAuthenticated() && auth.getPrincipal() instanceof org.springframework.security.oauth2.jwt.Jwt jwt) {
                return jwt.getTokenValue();
            }
            return null;
        }

        static java.util.List<String> audiences() {
            var auth = org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
            if (auth != null && auth.isAuthenticated() && auth.getPrincipal() instanceof org.springframework.security.oauth2.jwt.Jwt jwt && jwt.getAudience() != null) {
                return jwt.getAudience();
            }
            return java.util.List.of();
        }

        static Object capture() {
            return org.springframework.security.core.context.SecurityContextHolder.getContext();
        }

        static AutoCloseable restore(Object context) {
            var previous = org.springframework.security.core.context.SecurityContextHolder.getContext();
            if (context instanceof org.springframework.security.core.context.SecurityContext c) {
                org.springframework.security.core.context.SecurityContextHolder.setContext(c);
            }
            return () -> org.springframework.security.core.context.SecurityContextHolder.setContext(previous);
        }
    }
}
