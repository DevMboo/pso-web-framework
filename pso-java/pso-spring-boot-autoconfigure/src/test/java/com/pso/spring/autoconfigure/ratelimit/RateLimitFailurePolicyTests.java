package com.pso.spring.autoconfigure.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.spring.autoconfigure.PsoProperties;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/** What the filter does when the shared backend cannot decide: the policy is explicit (closed is the secure default). */
class RateLimitFailurePolicyTests {

    private static final PolicyRateLimiter BROKEN = new PolicyRateLimiter() {
        @Override
        public Decision check(String key, RatePolicy policy) {
            return new Decision(false, policy.limit(), -1, 1, true);
        }

        @Override
        public Stats stats() {
            return new Stats(0, 0, 1, -1);
        }
    };

    private static RateLimitSettings settings(String onFailure) {
        PsoProperties.Requests r = new PsoProperties.Requests();
        r.setOnFailure(onFailure);
        return RateLimitSettings.from(r);
    }

    private MockHttpServletResponse call(String onFailure, AtomicInteger reached) throws Exception {
        ClientRateLimitFilter f = new ClientRateLimitFilter(BROKEN, settings(onFailure));
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/users/customers/1");
        req.setRemoteAddr("203.0.113.5");
        MockHttpServletResponse res = new MockHttpServletResponse();
        f.doFilter(req, res, new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest r, jakarta.servlet.ServletResponse s) {
                reached.incrementAndGet();
            }
        });
        return res;
    }

    @Test
    void closedRefusesWithAProblemAndRetryAfter() throws Exception {
        AtomicInteger reached = new AtomicInteger();
        MockHttpServletResponse res = call("closed", reached);
        assertThat(reached.get()).isZero();
        assertThat(res.getStatus()).isEqualTo(503);
        assertThat(res.getContentType()).startsWith("application/problem+json");
        assertThat(res.getContentAsString()).contains("\"code\":\"PSO_RATE_LIMIT_UNAVAILABLE\"");
        assertThat(res.getHeader("Retry-After")).isEqualTo("1");
    }

    @Test
    void openLetsTheRequestThrough() throws Exception {
        AtomicInteger reached = new AtomicInteger();
        MockHttpServletResponse res = call("open", reached);
        assertThat(reached.get()).isEqualTo(1);
        assertThat(res.getStatus()).isEqualTo(200);
    }
}
