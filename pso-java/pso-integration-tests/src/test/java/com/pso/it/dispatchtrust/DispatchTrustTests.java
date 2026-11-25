package com.pso.it.dispatchtrust;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.PsoDispatch;
import com.pso.dispatch.PsoEventHandler;
import com.pso.dispatch.Trust;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

/**
 * Trusted service identity across runtimes and REAL brokers: a Spring service signs, the TypeScript runtime verifies; the TypeScript
 * runtime signs, a Spring {@code @PsoEventHandler} verifies; unsigned and forged messages are handled by neither. The signature travels
 * in transport headers, which Redis Streams, RabbitMQ and Kafka each carry differently in each client library.
 */
class DispatchTrustTests {

    static final String JAVA_KEY = "java-service-key-" + "j".repeat(30), TS_KEY = "ts-service-key-" + "t".repeat(30), ROGUE_KEY = "rogue-key-" + "r".repeat(30);

    @SpringBootApplication
    public static class TrustApp {
        @Component
        public static class Handlers {
            public final List<String> seen = new CopyOnWriteArrayList<>();

            @PsoEventHandler("it.user-created")
            public void on(JsonNode e, ConsumeContext ctx) {
                seen.add(e.get("run").asText() + ":" + e.get("n").asInt() + ":claimed=" + ctx.envelope().source() + ":verified=" + ctx.verifiedSource());
            }
        }
    }

    /** Security defaults: the same production rule as the Node runtime, enforced when the Spring context starts. */
    @Test
    void productionRefusesAnUnauthenticatedDispatchUnlessDeclared() {
        requireBroker("redis");
        // development: unchanged
        try (ConfigurableApplicationContext ctx = run("redis", "it-dev-" + UUID.randomUUID().toString().substring(0, 6) + "-service")) {
            assertThat(ctx.getBean(DispatchRuntime.class).trust().mode()).isEqualTo(Trust.Mode.OFF);
        }
        // production (the profile the generated image sets), nothing configured: the context does not start, and says what to do
        assertThatThrownBy(() -> run("redis", "it-prod-service", "spring.profiles.active=prod").close())
            .hasStackTraceContaining("production requires publisher authentication")
            .hasStackTraceContaining("PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true (insecure");
        assertThatThrownBy(() -> run("redis", "it-prod-service", "PSO_ENV=production").close()).hasStackTraceContaining("production requires publisher authentication");
        // explicit legacy declaration: starts, trust stays off (nothing is verified by declaration)
        try (ConfigurableApplicationContext ctx = run("redis", "it-legacy-" + UUID.randomUUID().toString().substring(0, 6) + "-service", "spring.profiles.active=prod", "pso.dispatch.allow-unauthenticated=true")) {
            assertThat(ctx.getBean(DispatchRuntime.class).trust().mode()).isEqualTo(Trust.Mode.OFF);
        }
        // secure production
        try (ConfigurableApplicationContext ctx = run("redis", "it-secure-" + UUID.randomUUID().toString().substring(0, 6) + "-service", "spring.profiles.active=prod", "pso.dispatch.trust.mode=required",
            "pso.dispatch.signing-key=" + JAVA_KEY)) {
            assertThat(ctx.getBean(DispatchRuntime.class).trust().mode()).isEqualTo(Trust.Mode.REQUIRED);
        }
        // a privileged handler never falls back to the claimed source
        ConsumeContext unverified = new ConsumeContext(com.pso.dispatch.Envelope.create("it.user-created", 1, "billing-service", new ObjectMapper().createObjectNode(), null, null, null, null), 1, "g");
        assertThatThrownBy(unverified::requireVerifiedSource).isInstanceOf(com.pso.dispatch.DispatchException.class).hasMessageContaining("is not verified");
        assertThat(new ConsumeContext(unverified.envelope(), 1, "g", "billing-service").requireVerifiedSource()).isEqualTo("billing-service");
    }

    static Stream<String> providers() {
        return Stream.of("redis", "rabbitmq", "kafka");
    }

    static void requireBroker(String provider) {
        String k = switch (provider) {
            case "redis" -> "PSO_TEST_REDIS_URL";
            case "rabbitmq" -> "PSO_TEST_RABBITMQ_URL";
            default -> "PSO_TEST_KAFKA_BROKERS";
        };
        assumeTrue(System.getenv(k) != null, "no real " + provider + " available (run: node scripts/dispatch-brokers.mjs up)");
    }

    static ConfigurableApplicationContext run(String provider, String service, String... extra) {
        List<String> p = new ArrayList<>(List.of("server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "logging.level.com.pso.dispatch=ERROR", "pso.service.name=" + service, "pso.dispatch.enabled=true",
            "pso.dispatch.provider=" + provider, "pso.dispatch.retry.initial-delay=20ms", "pso.dispatch.retry.max-delay=50ms", "pso.security.enabled=false", "pso.limits.requests.enabled=false"));
        switch (provider) {
            case "redis" -> p.add("pso.dispatch.redis.url=" + System.getenv("PSO_TEST_REDIS_URL"));
            case "rabbitmq" -> p.add("pso.dispatch.rabbitmq.url=" + System.getenv("PSO_TEST_RABBITMQ_URL"));
            default -> {
                p.add("pso.dispatch.kafka.bootstrap-servers=" + System.getenv("PSO_TEST_KAFKA_BROKERS"));
                p.add("pso.dispatch.kafka.partitions=1");
            }
        }
        p.addAll(List.of(extra));
        return new SpringApplicationBuilder(TrustApp.class).properties(p.toArray(new String[0])).run();
    }

    static void until(BooleanSupplier c, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) {
                throw new AssertionError("timeout waiting for condition");
            }
            Thread.sleep(50);
        }
    }

    static Map<String, Object> event(String run, int n) {
        return Map.of("run", run, "n", n, "mode", "ok");
    }

    /** The TypeScript runtime as a child process (packages/dispatch/test/crosslang.ts); its output lines are collected. */
    record Node(Process process, List<String> out) implements AutoCloseable {
        @Override
        public void close() throws Exception {
            process.getOutputStream().close();
            process.destroy();
        }
    }

    static Node node(String provider, String mode, Map<String, String> extra) throws Exception {
        File script = new File("../../packages/dispatch/test/crosslang.ts").getCanonicalFile();
        ProcessBuilder pb = new ProcessBuilder("node", script.getPath());
        pb.environment().putAll(System.getenv());
        pb.environment().put("CL_PROVIDER", provider);
        pb.environment().put("CL_MODE", mode);
        pb.environment().putAll(extra);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        List<String> out = new CopyOnWriteArrayList<>();
        Thread.ofVirtual().start(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String l;
                while ((l = r.readLine()) != null) {
                    out.add(l);
                }
            } catch (java.io.IOException ignored) {
                // the process ended
            }
        });
        return new Node(p, out);
    }

    static String envName(String service) {
        return "PSO_DISPATCH_TRUST_KEY_" + service.toUpperCase().replace('-', '_');
    }

    @ParameterizedTest(name = "[{0}] a Spring service signs; the TypeScript runtime (required mode) verifies it and refuses unsigned and forged messages")
    @MethodSource("providers")
    void javaSignsTypeScriptVerifies(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        String javaService = "java-" + run.substring(0, 6) + "-service";
        try (Node ts = node(provider, "consume", Map.of("CL_GROUP", "ts-" + run.substring(0, 8), "CL_TRUST_MODE", "required", envName(javaService), JAVA_KEY))) {
            until(() -> ts.out().contains("READY") || !ts.process().isAlive(), 90_000);
            assertThat(ts.out()).contains("READY");
            // 1. the same service name WITHOUT a key, 2. the same name signing with a key that is not its own, 3. the real, signed service
            try (ConfigurableApplicationContext unsigned = run(provider, javaService)) {
                unsigned.getBean(PsoDispatch.class).publish("it.user-created", event(run, 1));
            }
            try (ConfigurableApplicationContext forger = run(provider, javaService, "pso.dispatch.signing-key=" + ROGUE_KEY)) {
                forger.getBean(PsoDispatch.class).publish("it.user-created", event(run, 2));
            }
            try (ConfigurableApplicationContext signed = run(provider, javaService, "pso.dispatch.signing-key=" + JAVA_KEY)) {
                assertThat(signed.getBean(DispatchRuntime.class).trust().signingKey()).isEqualTo(JAVA_KEY);
                signed.getBean(PsoDispatch.class).publish("it.user-created", event(run, 3));
            }
            until(() -> ts.out().stream().anyMatch(l -> l.startsWith("RECEIVED") && l.contains(run)), 90_000);
            Thread.sleep(1500); // room for a wrongly accepted message to show up
            List<JsonNode> got = new ArrayList<>();
            for (String l : ts.out()) {
                if (l.startsWith("RECEIVED") && l.contains(run)) {
                    got.add(new ObjectMapper().readTree(l.substring("RECEIVED ".length())));
                }
            }
            assertThat(got).as("only the authentic message was handled: %s", ts.out()).hasSize(1);
            assertThat(got.get(0).get("payload").get("n").asInt()).isEqualTo(3);
            assertThat(got.get(0).get("source").asText()).isEqualTo(javaService);
            assertThat(got.get(0).get("verifiedSource").asText()).as("TypeScript verified the signature Java produced").isEqualTo(javaService);
        }
    }

    @ParameterizedTest(name = "[{0}] the TypeScript runtime signs; a Spring @PsoEventHandler (required mode) verifies it and never sees unsigned or forged messages")
    @MethodSource("providers")
    void typeScriptSignsJavaVerifies(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        String consumer = "it-" + run.substring(0, 8) + "-service";
        try (ConfigurableApplicationContext ctx = run(provider, consumer, "pso.dispatch.trust.mode=required", "pso.dispatch.trust.keys.ts-service=" + TS_KEY)) {
            DispatchRuntime rt = ctx.getBean(DispatchRuntime.class);
            assertThat(rt.trust().mode()).isEqualTo(Trust.Mode.REQUIRED);
            Thread.sleep(provider.equals("kafka") ? 3000 : 500); // let the consumer group join before the messages arrive
            String payload = "CL_PAYLOAD", corr = "CL_CORRELATION", id = "CL_ID";
            ObjectMapper m = new ObjectMapper();
            // unsigned, forged (signed with a key that is not ts-service's), then authentic
            try (Node n = node(provider, "publish", Map.of(payload, m.writeValueAsString(event(run, 1)), corr, "corr-trust-1", id, "evt-u-" + run.substring(0, 8)))) {
                until(() -> n.out().stream().anyMatch(l -> l.startsWith("PUBLISHED")) || !n.process().isAlive(), 90_000);
                assertThat(n.out()).anyMatch(l -> l.startsWith("PUBLISHED " + provider));
            }
            try (Node n = node(provider, "publish", Map.of(payload, m.writeValueAsString(event(run, 2)), corr, "corr-trust-2", id, "evt-f-" + run.substring(0, 8), "PSO_DISPATCH_SIGNING_KEY", ROGUE_KEY))) {
                until(() -> n.out().stream().anyMatch(l -> l.startsWith("PUBLISHED")) || !n.process().isAlive(), 90_000);
                assertThat(n.out()).anyMatch(l -> l.startsWith("PUBLISHED " + provider));
            }
            try (Node n = node(provider, "publish", Map.of(payload, m.writeValueAsString(event(run, 3)), corr, "corr-trust-3", id, "evt-s-" + run.substring(0, 8), "PSO_DISPATCH_SIGNING_KEY", TS_KEY))) {
                until(() -> n.out().stream().anyMatch(l -> l.startsWith("PUBLISHED")) || !n.process().isAlive(), 90_000);
                assertThat(n.out()).anyMatch(l -> l.startsWith("PUBLISHED " + provider));
            }
            TrustApp.Handlers h = ctx.getBean(TrustApp.Handlers.class);
            until(() -> h.seen.stream().anyMatch(s -> s.startsWith(run)), 90_000);
            Thread.sleep(1500);
            assertThat(h.seen.stream().filter(s -> s.startsWith(run)).toList()).as("Java verified the signature TypeScript produced, and only that message").containsExactly(run + ":3:claimed=ts-service:verified=ts-service");
            assertThat(rt.untrusted()).as("the unsigned and the forged message (and any older unsigned traffic on the shared channel) were refused").isGreaterThanOrEqualTo(2);
        }
    }

    @Test
    void startUpRefusesAWeakKeyAndAnUnknownModeWithoutEchoingTheKey() {
        for (String[] bad : new String[][] {{"pso.dispatch.signing-key=short-signing-key", "32"}, {"pso.dispatch.trust.mode=strictest", "off, permissive, required"}, {"pso.dispatch.trust.keys.users-service=short-trust-key", "32"}}) {
            assertThatThrownBy(() -> new SpringApplicationBuilder(TrustApp.class).properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF", "pso.service.name=bad-service",
                "pso.security.enabled=false", "pso.dispatch.enabled=true", "pso.dispatch.provider=redis", "pso.dispatch.redis.url=redis://127.0.0.1:1", bad[0]).run().close())
                .as(bad[0]).satisfies(t -> {
                    StringBuilder all = new StringBuilder();
                    for (Throwable c = t; c != null; c = c.getCause()) {
                        all.append(c.getMessage()).append('\n');
                    }
                    assertThat(all.toString()).contains(bad[1]).doesNotContain("short-trust-key");
                });
        }
    }
}
