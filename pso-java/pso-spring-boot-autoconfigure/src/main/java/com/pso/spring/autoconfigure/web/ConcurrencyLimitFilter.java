package com.pso.spring.autoconfigure.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.concurrent.Semaphore;
import org.springframework.web.filter.OncePerRequestFilter;

/** Bounds the number of requests handled at once; the excess is rejected immediately with 503 instead of queueing without limit. */
public class ConcurrencyLimitFilter extends OncePerRequestFilter {

    private final Semaphore permits;

    public ConcurrencyLimitFilter(int max) {
        this.permits = new Semaphore(max);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().startsWith("/actuator/health");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        if (!permits.tryAcquire()) {
            res.setHeader("Retry-After", "1");
            com.pso.spring.autoconfigure.problem.Problems.write(req, res, "server_busy");
            return;
        }
        try {
            chain.doFilter(req, res);
        } finally {
            permits.release();
        }
    }
}
