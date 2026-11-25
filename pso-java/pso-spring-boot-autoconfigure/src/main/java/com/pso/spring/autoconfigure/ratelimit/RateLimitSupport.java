package com.pso.spring.autoconfigure.ratelimit;

import com.pso.spring.autoconfigure.problem.Problems;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/** Shared by the client filter and the principal/route interceptor: runs one check and writes the refusal as an RFC 9457 problem. */
final class RateLimitSupport {

    private RateLimitSupport() {
    }

    /** @return true when the request may proceed; false when a response was written */
    static boolean admit(PolicyRateLimiter limiter, RateLimitSettings settings, String key, RatePolicy policy, HttpServletRequest req, HttpServletResponse res) throws IOException {
        PolicyRateLimiter.Decision d = limiter.check(key, policy);
        if (d.backendFailed()) {
            if (settings.failOpen()) {
                return true;
            }
            res.setHeader("Retry-After", "1");
            Problems.write(req, res, "rate_limit_unavailable"); // fail-closed policy and the shared backend is down
            return false;
        }
        res.setHeader("RateLimit-Limit", Integer.toString(d.limit()));
        if (d.allowed()) {
            res.setHeader("RateLimit-Remaining", Long.toString(d.remaining()));
            return true;
        }
        res.setHeader("Retry-After", Long.toString(d.retryAfterSeconds()));
        res.setHeader("RateLimit-Reset", Long.toString(d.retryAfterSeconds()));
        Problems.write(req, res, "too_many_requests");
        return false;
    }
}
