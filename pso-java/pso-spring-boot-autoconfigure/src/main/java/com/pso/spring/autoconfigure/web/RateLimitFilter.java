package com.pso.spring.autoconfigure.web;

import com.pso.spring.autoconfigure.RateLimiter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Applies the {@link RateLimiter} per client. The key is the socket's remote address: X-Forwarded-For and similar headers are
 * NEVER read here because any client can forge them. Behind a trusted proxy, configure the container's forwarded-header handling
 * (server.forward-headers-strategy) explicitly so getRemoteAddr() already reflects the real client.
 */
public class RateLimitFilter extends OncePerRequestFilter {

    private final RateLimiter limiter;

    public RateLimitFilter(RateLimiter limiter) {
        this.limiter = limiter;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().startsWith("/actuator/health"); // platform probes are never throttled
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        RateLimiter.Decision d = limiter.tryAcquire(req.getRemoteAddr());
        if (!d.allowed()) {
            res.setHeader("Retry-After", Long.toString(d.retryAfterSeconds()));
            com.pso.spring.autoconfigure.problem.Problems.write(req, res, "too_many_requests");
            return;
        }
        chain.doFilter(req, res);
    }
}
