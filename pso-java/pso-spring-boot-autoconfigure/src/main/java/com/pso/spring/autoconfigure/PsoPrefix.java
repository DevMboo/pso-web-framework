package com.pso.spring.autoconfigure;

import java.util.regex.Pattern;

/**
 * Service endpoint prefix rules. The prefix is applied exactly once, by PSO, to every {@code @RestController}
 * (see {@link PsoWebConfiguration}); controllers must therefore map paths WITHOUT it, and the servlet context path must stay empty.
 */
public final class PsoPrefix {

    private static final Pattern VALID = Pattern.compile("^(/[a-z0-9][a-z0-9._~-]*)+$");

    private PsoPrefix() {
    }

    /**
     * Normalizes: adds the leading slash and drops trailing and duplicate slashes. "/" and "" both mean "no prefix" and
     * normalize to the empty string.
     *
     * @throws IllegalArgumentException for upper case, characters outside {@code [a-z0-9._~-/]} or "." and ".." segments
     */
    public static String normalize(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("prefix is required");
        }
        String p = raw.trim().replaceAll("/+", "/");
        if (p.isEmpty() || p.equals("/")) {
            return "";
        }
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        while (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        for (String seg : p.substring(1).split("/")) {
            if (seg.equals(".") || seg.equals("..")) {
                throw new IllegalArgumentException("invalid prefix \"" + raw + "\": dot segments are not allowed");
            }
        }
        if (!VALID.matcher(p).matches()) {
            throw new IllegalArgumentException("invalid prefix \"" + raw + "\": use lower-case letters, digits and . _ ~ - separated by /");
        }
        return p;
    }

    /** users-service becomes /users; notification-service becomes /notification; a name without the suffix is used as is. */
    public static String derive(String serviceName) {
        if (serviceName == null || serviceName.isBlank()) {
            throw new IllegalArgumentException("cannot derive a prefix without a service name");
        }
        String suffix = "-service";
        String base = serviceName.endsWith(suffix) && serviceName.length() > suffix.length()
            ? serviceName.substring(0, serviceName.length() - suffix.length())
            : serviceName;
        return normalize("/" + base);
    }
}
