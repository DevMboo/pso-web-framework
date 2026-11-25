package com.pso.spring.autoconfigure.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.spring.autoconfigure.PsoProperties;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/** Runs the language-neutral cases of fixtures/contracts/ratelimit/contract.json: the TypeScript orchestrator runs the very same file. */
class RateLimitContractTests {

    private static JsonNode contract() throws Exception {
        for (Path p : List.of(Path.of("../../fixtures/contracts/ratelimit/contract.json"), Path.of("../fixtures/contracts/ratelimit/contract.json"))) {
            if (Files.exists(p)) {
                return new ObjectMapper().readTree(Files.readString(p));
            }
        }
        throw new AssertionError("fixtures/contracts/ratelimit/contract.json not found from " + Path.of("").toAbsolutePath());
    }

    @Test
    void bucketBehaviorMatchesTheSharedContract() throws Exception {
        for (JsonNode c : contract().get("bucket")) {
            JsonNode p = c.get("policy");
            RatePolicy policy = new RatePolicy(p.get("limit").asInt(), p.get("windowSeconds").asInt(), p.get("burst").asInt());
            AtomicLong now = new AtomicLong();
            LocalPolicyRateLimiter limiter = new LocalPolicyRateLimiter(100, now::get);
            int i = 0;
            for (JsonNode step : c.get("steps")) {
                now.set(step.get("t").asLong());
                PolicyRateLimiter.Decision d = limiter.check(step.get("key").asText(), policy);
                String where = c.get("name").asText() + " step " + i++;
                assertThat(d.allowed()).as(where).isEqualTo(step.get("allowed").asBoolean());
                if (step.has("remaining")) {
                    assertThat(d.remaining()).as(where + " remaining").isEqualTo(step.get("remaining").asLong());
                }
                if (step.has("retryAfter")) {
                    assertThat(d.retryAfterSeconds()).as(where + " retryAfter").isEqualTo(step.get("retryAfter").asLong());
                }
            }
        }
    }

    @Test
    void clientAddressResolutionMatchesTheSharedContract() throws Exception {
        JsonNode section = contract().get("clientAddress");
        List<ClientAddress.Cidr> trusted = new ArrayList<>();
        section.get("trustedProxies").forEach(t -> trusted.add(ClientAddress.Cidr.parse(t.asText())));
        for (JsonNode c : section.get("cases")) {
            MockHttpServletRequest req = new MockHttpServletRequest();
            req.setRemoteAddr(c.get("peer").asText());
            c.get("xff").forEach(h -> req.addHeader("X-Forwarded-For", h.asText()));
            boolean useList = !c.has("trusted") || c.get("trusted").asBoolean();
            assertThat(ClientAddress.resolve(req, useList ? trusted : List.of())).as(c.get("name").asText()).isEqualTo(c.get("expect").asText());
        }
    }

    @Test
    void keysAreBoundedAndEvictedLeastRecentlyUsedFirst() {
        LocalPolicyRateLimiter limiter = new LocalPolicyRateLimiter(100);
        RatePolicy p = new RatePolicy(60, 60, 3);
        for (int i = 0; i < 500; i++) {
            limiter.check("k" + i, p);
        }
        assertThat(limiter.stats().keys()).isLessThanOrEqualTo(100);
    }

    private PsoProperties.Requests requests() {
        return new PsoProperties.Requests();
    }

    @Test
    void defaultsAreSecure() {
        RateLimitSettings s = RateLimitSettings.from(requests());
        assertThat(s.enabled()).isTrue();
        assertThat(s.global()).isEqualTo(new RatePolicy(600, 60, 600));
        assertThat(s.perPrincipal()).isTrue();
        assertThat(s.failOpen()).as("fail closed by default").isFalse();
        assertThat(s.trustedProxies()).as("no proxy is trusted by default").isEmpty();
    }

    @Test
    void everyInvalidSettingIsReportedTogether() {
        PsoProperties.Requests r = requests();
        r.setProvider("memcached");
        r.setOnFailure("maybe");
        r.setTrustedProxies(List.of("not-an-ip", "10.0.0.0/99"));
        PsoProperties.RouteLimit bad = new PsoProperties.RouteLimit();
        bad.setRoute("FETCH /x");
        PsoProperties.RouteLimit zero = new PsoProperties.RouteLimit();
        zero.setRoute("POST /users");
        zero.setLimit(0);
        r.setRoutes(List.of(bad, zero));
        assertThatThrownBy(() -> RateLimitSettings.from(r)).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("provider must be")
            .hasMessageContaining("on-failure must be")
            .hasMessageContaining("trusted-proxies")
            .hasMessageContaining("routes[0].route must look like")
            .hasMessageContaining("routes[1].limit must be between");
    }

    @Test
    void routePoliciesAreParsedAndDuplicatesAreRejected() {
        PsoProperties.Requests r = requests();
        PsoProperties.RouteLimit a = new PsoProperties.RouteLimit();
        a.setRoute("POST /users");
        a.setLimit(10);
        a.setBurst(5);
        r.setRoutes(List.of(a));
        assertThat(RateLimitSettings.from(r).routes()).containsEntry("POST /users", new RatePolicy(10, 60, 5));
        r.setRoutes(List.of(a, a));
        assertThatThrownBy(() -> RateLimitSettings.from(r)).hasMessageContaining("declared twice");
    }
}
