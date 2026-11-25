package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.it.app.TestApp;
import com.pso.test.PsoTestJwt;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.boot.web.context.WebServerApplicationContext;

/**
 * Spring rate limiting against a REAL Redis shared by several real application instances, with real JWT validation. Redis tests are
 * skipped (reported as unverified, never replaced by mocks) when no Redis is available (scripts/dispatch-brokers.mjs).
 */
class RateLimitTests {

    static final ObjectMapper MAPPER = new ObjectMapper();

    static String redis() {
        String url = System.getenv("PSO_TEST_REDIS_URL");
        assumeTrue(url != null, "no real Redis available (run: node scripts/dispatch-brokers.mjs up)");
        return url;
    }

    static List<String> base(String... extra) {
        List<String> p = new ArrayList<>(List.of("server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "pso.service.name=users-service",
            "pso.security.jwt.jwks-uri=" + Base.JWT.jwksUri(), "pso.security.jwt.issuer=" + PsoTestJwt.ISSUER, "pso.security.jwt.audience=" + PsoTestJwt.AUDIENCE,
            "pso.security.jwt.algorithms=ES256", "pso.limits.requests.per-minute=100000", "pso.dispatch.enabled=false",
            // the customer routes are public here, so anonymous callers reach the second stage; a token, when sent, still identifies the principal
            "pso.security.rules[0].path=/customers/**", "pso.security.rules[0].access=PUBLIC"));
        p.addAll(List.of(extra));
        return p;
    }

    static ConfigurableApplicationContext run(String... props) {
        return new SpringApplicationBuilder(TestApp.class).properties(base(props).toArray(new String[0])).run();
    }

    static int port(ConfigurableApplicationContext c) {
        return ((WebServerApplicationContext) c).getWebServer().getPort();
    }

    static HttpResponse<String> get(int port, String path, String token, String xff) {
        HttpRequest.Builder b = Http.req(port, path, token);
        if (xff != null) {
            b.header("X-Forwarded-For", xff);
        }
        return Http.send(b.GET());
    }

    static String redisProps(String prefix) {
        return "pso.limits.requests.provider=redis";
    }

    static String[] shared(String prefix, String... extra) {
        List<String> p = new ArrayList<>(List.of("pso.limits.requests.provider=redis", "pso.limits.requests.redis-url=" + redis(), "pso.limits.requests.redis-prefix=" + prefix));
        p.addAll(List.of(extra));
        return p.toArray(new String[0]);
    }

    static JsonNode json(HttpResponse<String> r) throws Exception {
        return MAPPER.readTree(r.body());
    }

    // ------------------------------------------------------------------ shared budget across instances

    @Test
    void twoInstancesSharingRedisEnforceOneBudgetUnderConcurrency() throws Exception {
        String prefix = "it:" + UUID.randomUUID() + ":";
        try (ConfigurableApplicationContext a = run(shared(prefix, "pso.limits.requests.per-minute=10"));
             ConfigurableApplicationContext b = run(shared(prefix, "pso.limits.requests.per-minute=10"))) {
            ExecutorService pool = Executors.newFixedThreadPool(16);
            List<Future<Integer>> results = new ArrayList<>();
            for (int i = 0; i < 100; i++) {
                int port = i % 2 == 0 ? port(a) : port(b);
                Callable<Integer> call = () -> get(port, "/users/customers/1", null, null).statusCode();
                results.add(pool.submit(call));
            }
            int ok = 0, limited = 0;
            for (Future<Integer> f : results) {
                int s = f.get();
                if (s == 200) {
                    ok++;
                } else if (s == 429) {
                    limited++;
                }
            }
            pool.shutdown();
            assertThat(ok).as("the burst is shared by both instances (not 10 each)").isBetween(10, 11);
            assertThat(ok + limited).isEqualTo(100);
            HttpResponse<String> refused = get(port(a), "/users/customers/1", null, null);
            assertThat(refused.statusCode()).isEqualTo(429);
            assertThat(refused.headers().firstValue("content-type").orElse("")).startsWith("application/problem+json");
            assertThat(json(refused).get("code").asText()).isEqualTo("PSO_RATE_LIMITED");
            assertThat(Long.parseLong(refused.headers().firstValue("retry-after").orElse("0"))).isGreaterThanOrEqualTo(1);
            assertThat(get(port(b), "/actuator/health", null, null).statusCode()).as("health probes are never limited").isEqualTo(200);
        }
    }

    // ------------------------------------------------------------------ isolation

    @Test
    void principalsAndRoutesHaveIndependentBudgets() throws Exception {
        String prefix = "it:" + UUID.randomUUID() + ":";
        String alice = Base.JWT.token("alice", List.of(), List.of());
        String bob = Base.JWT.token("bob", List.of(), List.of());
        try (ConfigurableApplicationContext c = run(shared(prefix, "pso.limits.requests.routes[0].route=GET /customers/{id}", "pso.limits.requests.routes[0].limit=3",
            "pso.limits.requests.routes[0].window-seconds=3600"))) {
            int port = port(c);
            List<Integer> a = new ArrayList<>(), b = new ArrayList<>(), anon = new ArrayList<>(), other = new ArrayList<>();
            for (int i = 0; i < 5; i++) {
                a.add(get(port, "/users/customers/1", alice, null).statusCode());
            }
            for (int i = 0; i < 5; i++) {
                b.add(get(port, "/users/customers/1", bob, null).statusCode());
            }
            for (int i = 0; i < 5; i++) {
                anon.add(get(port, "/users/customers/1", null, null).statusCode());
            }
            for (int i = 0; i < 5; i++) {
                other.add(get(port, "/users/customers/slow", alice, null).statusCode());
            }
            assertThat(a).as("alice").containsExactly(200, 200, 200, 429, 429);
            assertThat(b).as("bob has a budget of his own").containsExactly(200, 200, 200, 429, 429);
            assertThat(anon).as("anonymous callers are isolated from authenticated principals (keyed by address)").containsExactly(200, 200, 200, 429, 429);
            assertThat(other).as("a route without a policy is not limited by the route policy of another route").containsOnly(200);
        }
    }

    @Test
    void forwardedHeadersCannotBeUsedToBypassOrToShareALimit() throws Exception {
        String prefix = "it:" + UUID.randomUUID() + ":";
        // 1) no trusted proxy: the header is never read, so rotating it does not help
        try (ConfigurableApplicationContext c = run(shared(prefix + "a:", "pso.limits.requests.per-minute=5", "pso.limits.requests.per-principal=false"))) {
            long limited = 0;
            for (int i = 0; i < 20; i++) {
                if (get(port(c), "/users/customers/1", null, "203.0.113." + i).statusCode() == 429) {
                    limited++;
                }
            }
            assertThat(limited).as("a spoofed X-Forwarded-For does not evade the limit").isGreaterThanOrEqualTo(14);
        }
        // 2) behind a trusted proxy each forwarded client has its own budget, and a prepended value is ignored
        try (ConfigurableApplicationContext c = run(shared(prefix + "b:", "pso.limits.requests.per-minute=3", "pso.limits.requests.per-principal=false",
            "pso.limits.requests.trusted-proxies[0]=127.0.0.1", "pso.limits.requests.trusted-proxies[1]=::1"))) {
            int port = port(c);
            for (int i = 0; i < 3; i++) {
                assertThat(get(port, "/users/customers/1", null, "198.51.100.1").statusCode()).isEqualTo(200);
            }
            assertThat(get(port, "/users/customers/1", null, "198.51.100.1").statusCode()).as("client 1 exhausted its own budget").isEqualTo(429);
            assertThat(get(port, "/users/customers/1", null, "198.51.100.2").statusCode()).as("client 2 has its own budget").isEqualTo(200);
            assertThat(get(port, "/users/customers/1", null, "6.6.6.6, 198.51.100.1").statusCode()).as("a client-prepended value is ignored: still client 1").isEqualTo(429);
        }
    }

    // ------------------------------------------------------------------ configuration failures stop start-up

    @Test
    void invalidConfigurationStopsStartupAndNeverEchoesTheRedisUrl() {
        assertThatThrownBy(() -> run("pso.limits.requests.provider=memcached")).hasStackTraceContaining("provider must be");
        assertThatThrownBy(() -> run("pso.limits.requests.trusted-proxies[0]=not-an-ip", "pso.limits.requests.routes[0].route=FETCH /x")).hasStackTraceContaining("trusted-proxies").hasStackTraceContaining("routes[0].route must look like");
        assertThatThrownBy(() -> run("pso.limits.requests.provider=redis")).hasStackTraceContaining("requires pso.limits.requests.redis-url");
        assertThatThrownBy(() -> run("pso.limits.requests.provider=redis", "pso.limits.requests.redis-url=redis://:topsecret@127.0.0.1:1"))
            .satisfies(e -> {
                String all = stack(e);
                assertThat(all).contains("cannot connect to Redis for rate limiting");
                assertThat(all).as("credentials never reach the failure message").doesNotContain("topsecret");
            });
    }

    @Test
    void redisIsNeverContactedUnlessSelected() {
        // the starter is on the classpath; with the default provider nothing connects (an unreachable URL would otherwise fail start-up)
        try (ConfigurableApplicationContext c = run("pso.limits.requests.redis-url=redis://127.0.0.1:1")) {
            assertThat(get(port(c), "/actuator/health", null, null).statusCode()).isEqualTo(200);
        }
    }

    static String stack(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable x = t; x != null; x = x.getCause()) {
            sb.append(x.getClass().getName()).append(": ").append(x.getMessage()).append('\n');
        }
        return sb.toString();
    }
}
