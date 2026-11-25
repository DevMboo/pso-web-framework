package com.pso.spring.security;

import com.pso.spring.autoconfigure.PsoProperties;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * Turns {@code pso.security.cors.*} into a real CORS policy. Validation is strict on purpose: malformed origins, wildcard
 * origins and wildcard-with-credentials are start-up errors, never silently widened or ignored. CORS is a browser rule; it is
 * not authentication and does not make another service trusted.
 */
public final class PsoCorsPolicy {

    private static final Pattern ORIGIN_PATTERN = Pattern.compile("^https?://\\*\\.[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\\d{1,5})?$");
    private static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9-]+$");
    private static final Set<String> METHODS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD");

    private PsoCorsPolicy() {
    }

    public static CorsConfigurationSource build(PsoProperties.Cors c) {
        List<String> problems = new ArrayList<>();
        if (c.getAllowedOrigins().isEmpty() && c.getAllowedOriginPatterns().isEmpty()) {
            problems.add("pso.security.cors.enabled=true requires allowed-origins (or allowed-origin-patterns); CORS never defaults to allowing every origin");
        }
        for (String o : c.getAllowedOrigins()) {
            String why = originProblem(o);
            if (why != null) {
                problems.add("allowed-origins \"" + o + "\": " + why);
            }
        }
        for (String p : c.getAllowedOriginPatterns()) {
            if (!ORIGIN_PATTERN.matcher(p).matches()) {
                problems.add("allowed-origin-patterns \"" + p + "\": use scheme://*.domain[:port], for example https://*.example.com");
            }
        }
        if (c.isAllowCredentials() && !c.getAllowedOriginPatterns().isEmpty()) {
            problems.add("allow-credentials=true cannot be combined with wildcard origin patterns; list exact origins instead");
        }
        for (String m : c.getAllowedMethods()) {
            if (!METHODS.contains(m)) {
                problems.add("allowed-methods \"" + m + "\": expected one of " + METHODS);
            }
        }
        for (String h : c.getAllowedHeaders()) {
            if (!TOKEN.matcher(h).matches()) {
                problems.add("allowed-headers \"" + h + "\": list explicit header names (no wildcard)");
            }
        }
        for (String h : c.getExposedHeaders()) {
            if (!TOKEN.matcher(h).matches()) {
                problems.add("exposed-headers \"" + h + "\": list explicit header names (no wildcard)");
            }
        }
        if (c.getMaxAge() == null || c.getMaxAge().isNegative()) {
            problems.add("max-age must not be negative");
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Invalid pso.security.cors configuration:\n - " + String.join("\n - ", problems));
        }
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(new ArrayList<>(c.getAllowedOrigins()));
        cfg.setAllowedOriginPatterns(new ArrayList<>(c.getAllowedOriginPatterns()));
        cfg.setAllowedMethods(new ArrayList<>(c.getAllowedMethods()));
        cfg.setAllowedHeaders(new ArrayList<>(c.getAllowedHeaders()));
        cfg.setExposedHeaders(new ArrayList<>(c.getExposedHeaders()));
        cfg.setAllowCredentials(c.isAllowCredentials());
        cfg.setMaxAge(c.getMaxAge());
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
    }

    /** @return null when the origin is a well-formed exact origin, otherwise the reason */
    static String originProblem(String origin) {
        if (origin == null || origin.isBlank()) {
            return "must not be blank";
        }
        if (origin.contains("*")) {
            return "wildcards are not allowed here (use allowed-origin-patterns for a wildcard subdomain)";
        }
        URI u;
        try {
            u = new URI(origin);
        } catch (URISyntaxException e) {
            return "not a valid origin";
        }
        if (u.getScheme() == null || !(u.getScheme().equals("http") || u.getScheme().equals("https"))) {
            return "must start with http:// or https://";
        }
        if (u.getHost() == null) {
            return "must contain a host";
        }
        if (u.getUserInfo() != null) {
            return "must not contain credentials";
        }
        if ((u.getPath() != null && !u.getPath().isEmpty()) || u.getQuery() != null || u.getFragment() != null) {
            return "must be scheme://host[:port] with no path, query or fragment (browsers send origins without a trailing slash)";
        }
        return null;
    }
}
