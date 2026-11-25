package com.pso.spring.autoconfigure.ratelimit;

import com.pso.spring.autoconfigure.PsoProperties;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** The validated rate limit configuration. Every problem is reported together and stops start-up (same rules as the orchestrator). */
public record RateLimitSettings(boolean enabled, RatePolicy global, boolean perPrincipal, boolean failOpen, List<ClientAddress.Cidr> trustedProxies,
                                Map<String, RatePolicy> routes, int maxKeys) {

    private static final Pattern ROUTE = Pattern.compile("^(GET|POST|PUT|PATCH|DELETE) /\\S*$");

    public static RateLimitSettings from(PsoProperties.Requests r) {
        List<String> problems = new ArrayList<>();
        if (!r.getProvider().equals("local") && !r.getProvider().equals("redis")) {
            problems.add("pso.limits.requests.provider must be \"local\" or \"redis\"");
        }
        if (!r.getOnFailure().equals("open") && !r.getOnFailure().equals("closed")) {
            problems.add("pso.limits.requests.on-failure must be \"open\" or \"closed\"");
        }
        List<ClientAddress.Cidr> trusted = new ArrayList<>();
        for (String t : r.getTrustedProxies()) {
            try {
                trusted.add(ClientAddress.Cidr.parse(t));
            } catch (IllegalArgumentException e) {
                problems.add("pso.limits.requests.trusted-proxies: " + e.getMessage());
            }
        }
        Map<String, RatePolicy> routes = new LinkedHashMap<>();
        int i = 0;
        for (PsoProperties.RouteLimit rl : r.getRoutes()) {
            String where = "pso.limits.requests.routes[" + i++ + "]";
            if (rl.getRoute() == null || !ROUTE.matcher(rl.getRoute()).matches()) {
                problems.add(where + ".route must look like \"POST /customers\"");
                continue;
            }
            int burst = rl.getBurst() != null ? rl.getBurst() : rl.getLimit();
            if (rl.getLimit() < 1 || rl.getLimit() > 1_000_000) {
                problems.add(where + ".limit must be between 1 and 1000000");
            } else if (rl.getWindowSeconds() < 1 || rl.getWindowSeconds() > 86_400) {
                problems.add(where + ".window-seconds must be between 1 and 86400");
            } else if (burst < 1 || burst > 1_000_000) {
                problems.add(where + ".burst must be between 1 and 1000000");
            } else if (routes.put(rl.getRoute(), new RatePolicy(rl.getLimit(), rl.getWindowSeconds(), burst)) != null) {
                problems.add(where + ".route \"" + rl.getRoute() + "\" is declared twice");
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Invalid rate limit configuration; nothing was started:\n - " + String.join("\n - ", problems));
        }
        int burst = r.getBurst() != null ? r.getBurst() : r.getPerMinute();
        return new RateLimitSettings(r.isEnabled(), new RatePolicy(r.getPerMinute(), 60, burst), r.isPerPrincipal(), r.getOnFailure().equals("open"), List.copyOf(trusted), Map.copyOf(routes), r.getMaxKeys());
    }
}
