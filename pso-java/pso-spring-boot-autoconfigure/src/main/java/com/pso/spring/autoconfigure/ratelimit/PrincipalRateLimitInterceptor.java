package com.pso.spring.autoconfigure.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.security.Principal;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Second stage, after authentication (it runs once a controller was matched, so the principal and the route pattern are known):
 * a budget of its own per authenticated principal, and the route-specific policies. Keys mirror the TypeScript orchestrator:
 * {@code r:<METHOD /route>:<p:subject|ip:address>} for a route policy, {@code pr:p:<subject>} for the global per-principal budget.
 * Route policies name the route WITHOUT the service prefix (the same string used in the service's controllers).
 */
public class PrincipalRateLimitInterceptor implements HandlerInterceptor {

    private final PolicyRateLimiter limiter;
    private final RateLimitSettings settings;
    private final String prefix;

    public PrincipalRateLimitInterceptor(PolicyRateLimiter limiter, RateLimitSettings settings, String servicePrefix) {
        this.limiter = limiter;
        this.settings = settings;
        this.prefix = servicePrefix == null || servicePrefix.equals("/") ? "" : servicePrefix;
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) throws Exception {
        if (req.getRequestURI().startsWith("/actuator/health")) {
            return true;
        }
        Principal user = req.getUserPrincipal();
        String principal = user != null ? user.getName() : null;
        String pattern = (String) req.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        RatePolicy route = null;
        String routeKey = null;
        if (pattern != null && !settings.routes().isEmpty()) {
            String path = !prefix.isEmpty() && pattern.startsWith(prefix) ? pattern.substring(prefix.length()) : pattern;
            routeKey = req.getMethod() + " " + (path.isEmpty() ? "/" : path);
            route = settings.routes().get(routeKey);
        }
        if (route != null) {
            String id = principal != null ? "p:" + principal : "ip:" + ClientAddress.resolve(req, settings.trustedProxies());
            return RateLimitSupport.admit(limiter, settings, "r:" + routeKey + ":" + id, route, req, res);
        }
        if (principal != null && settings.perPrincipal() && settings.enabled()) {
            return RateLimitSupport.admit(limiter, settings, "pr:p:" + principal, settings.global(), req, res);
        }
        return true;
    }
}
