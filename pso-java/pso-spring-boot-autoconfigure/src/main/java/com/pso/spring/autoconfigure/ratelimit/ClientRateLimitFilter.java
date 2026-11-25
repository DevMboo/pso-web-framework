package com.pso.spring.autoconfigure.ratelimit;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/** First stage, before authentication: one budget per client address (see {@link ClientAddress} for how the address is determined). */
public class ClientRateLimitFilter extends OncePerRequestFilter {

    private final PolicyRateLimiter limiter;
    private final RateLimitSettings settings;

    public ClientRateLimitFilter(PolicyRateLimiter limiter, RateLimitSettings settings) {
        this.limiter = limiter;
        this.settings = settings;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().startsWith("/actuator/health"); // platform probes are never throttled
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String ip = ClientAddress.resolve(req, settings.trustedProxies());
        if (RateLimitSupport.admit(limiter, settings, "ip:" + ip, settings.global(), req, res)) {
            chain.doFilter(req, res);
        }
    }
}
