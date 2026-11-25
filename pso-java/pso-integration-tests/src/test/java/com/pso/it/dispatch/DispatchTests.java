package com.pso.it.dispatch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.PsoDispatch;
import com.pso.dispatch.kafka.KafkaAdapter;
import com.pso.dispatch.rabbitmq.RabbitMqAdapter;
import com.pso.dispatch.redis.RedisStreamsAdapter;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.time.Duration;
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
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Dispatch in real Spring Boot applications against REAL brokers (scripts/dispatch-brokers.mjs starts Redis, RabbitMQ and Kafka in
 * Docker and the PSO_TEST_* variables point here). Without them the broker tests are skipped and reported as unverified.
 */
class DispatchTests {

    static String env(String k) {
        return System.getenv(k);
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
        assumeTrue(env(k) != null, "no real " + provider + " available (run: node scripts/dispatch-brokers.mjs up)");
    }

    static List<String> props(String provider, String service, String... extra) {
        List<String> p = new ArrayList<>(List.of("server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "pso.service.name=" + service, "pso.dispatch.enabled=true", "pso.dispatch.provider=" + provider,
            "pso.dispatch.retry.initial-delay=20ms", "pso.dispatch.retry.max-delay=50ms", "pso.security.enabled=false", "pso.limits.requests.enabled=false"));
        switch (provider) {
            case "redis" -> p.add("pso.dispatch.redis.url=" + env("PSO_TEST_REDIS_URL"));
            case "rabbitmq" -> p.add("pso.dispatch.rabbitmq.url=" + env("PSO_TEST_RABBITMQ_URL"));
            default -> {
                p.add("pso.dispatch.kafka.bootstrap-servers=" + env("PSO_TEST_KAFKA_BROKERS"));
                p.add("pso.dispatch.kafka.partitions=1");
            }
        }
        p.addAll(List.of(extra));
        return p;
    }

    static ConfigurableApplicationContext run(String provider, String service, String... extra) {
        return new SpringApplicationBuilder(DispatchApp.class).properties(props(provider, service, extra).toArray(new String[0])).run();
    }

    static String service() {
        return "it-" + UUID.randomUUID().toString().substring(0, 8) + "-service";
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

    static Map<String, Object> event(String run, int n, String mode) {
        return Map.of("run", run, "n", n, "mode", mode);
    }

    // ------------------------------------------------------------------ defaults and misconfiguration (no broker needed)

    @Test
    void dispatchIsDisabledByDefaultEvenWithEveryProviderStarterOnTheClasspath() {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(DispatchApp.class).properties("server.port=0", "pso.service.name=plain-service", "logging.level.root=OFF", "pso.security.enabled=false").run()) {
            assertThat(ctx.getBean(PsoDispatch.class)).isInstanceOf(PsoDispatch.Disabled.class);
            assertThat(ctx.getBeansOfType(DispatchAdapter.class)).as("no adapter exists, so nothing can connect").isEmpty();
            assertThatThrownBy(() -> ctx.getBean(PsoDispatch.class).publish("it.user-created", event("r", 1, "ok"))).isInstanceOfSatisfying(DispatchException.class, e -> assertThat(e.code()).isEqualTo("PSO_DISPATCH_DISABLED"));
        }
    }

    static String failure(String... props) {
        List<String> all = new ArrayList<>(List.of(props));
        all.addAll(List.of("server.port=0", "pso.service.name=bad-service", "logging.level.root=OFF", "pso.security.enabled=false"));
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(DispatchApp.class).properties(all.toArray(new String[0])).run()) {
            throw new AssertionError("the application was expected to refuse to start");
        } catch (AssertionError e) {
            throw e;
        } catch (Throwable t) {
            StringBuilder sb = new StringBuilder();
            for (Throwable c = t; c != null; c = c.getCause()) {
                sb.append(c.getMessage()).append('\n');
            }
            return sb.toString();
        }
    }

    @Test
    void misconfigurationStopsStartUpWithActionableMessages() {
        assertThat(failure("pso.dispatch.enabled=true")).contains("requires pso.dispatch.provider").contains("pso dispatch:install");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=nats")).contains("provider");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=redis")).contains("pso.dispatch.redis.url");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=rabbitmq", "pso.dispatch.rabbitmq.url=http://wrong")).contains("amqp");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=kafka")).contains("bootstrap-servers");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=kafka", "pso.dispatch.kafka.bootstrap-servers=nohost")).contains("not host:port");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=kafka", "pso.dispatch.kafka.bootstrap-servers=h:9092", "pso.dispatch.kafka.sasl.mechanism=plain",
            "pso.dispatch.kafka.sasl.username=u", "pso.dispatch.kafka.sasl.password=p")).contains("TLS");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=redis", "pso.dispatch.redis.url=redis://x:1", "pso.dispatch.retry.initial-delay=1m", "pso.dispatch.retry.max-delay=1s")).contains("initial-delay");
        assertThat(failure("pso.dispatch.retry.max-attempts=0")).containsIgnoringCase("maxAttempts");
        assertThat(failure("pso.dispatch.consumer.concurency=2")).contains("concurency");
        assertThat(failure("pso.dispatch.enabled=true", "pso.dispatch.provider=redis", "pso.dispatch.redis.url=redis://x:1", "spring.autoconfigure.exclude=com.pso.dispatch.redis.PsoRedisAutoConfiguration"))
            .contains("no dispatch provider starter is on the classpath").contains("pso dispatch:install redis");
    }

    @Test
    void brokerUnavailableStopsStartUpWithoutLeakingCredentials() {
        String m = failure("pso.dispatch.enabled=true", "pso.dispatch.provider=redis", "pso.dispatch.redis.url=redis://:topsecret@127.0.0.1:1");
        assertThat(m).contains("cannot connect to Redis").doesNotContain("topsecret");
        String r = failure("pso.dispatch.enabled=true", "pso.dispatch.provider=rabbitmq", "pso.dispatch.rabbitmq.url=amqp://u:topsecret@127.0.0.1:1");
        assertThat(r).contains("cannot connect to RabbitMQ").doesNotContain("topsecret");
    }

    // ------------------------------------------------------------------ real brokers

    @ParameterizedTest(name = "[{0}] publish -> @PsoEventHandler with a typed payload, acknowledgement states the guarantee")
    @MethodSource("providers")
    void roundTrip(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        try (ConfigurableApplicationContext ctx = run(provider, service())) {
            PsoDispatch d = ctx.getBean(PsoDispatch.class);
            var r = d.publish("it.user-created", event(run, 7, "ok"));
            assertThat(r.provider()).isEqualTo(provider);
            assertThat(r.acknowledgement()).hasSizeGreaterThan(10);
            DispatchApp.Handlers h = ctx.getBean(DispatchApp.Handlers.class);
            until(() -> h.seen.stream().anyMatch(s -> s.startsWith(run + ":7")), 60_000);
            assertThat(d.health().up()).isTrue();
            assertThat(d.metrics().published()).isEqualTo(1);
        }
    }

    @ParameterizedTest(name = "[{0}] a failing handler is retried and then succeeds on the third attempt")
    @MethodSource("providers")
    void retryThenSuccess(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        try (ConfigurableApplicationContext ctx = run(provider, service())) {
            ctx.getBean(PsoDispatch.class).publish("it.user-created", event(run, 1, "fail-twice"));
            DispatchApp.Handlers h = ctx.getBean(DispatchApp.Handlers.class);
            until(() -> h.seen.contains(run + ":1:attempt3"), 60_000);
            assertThat(ctx.getBean(PsoDispatch.class).metrics().retried()).isGreaterThanOrEqualTo(2);
        }
    }

    @ParameterizedTest(name = "[{0}] a message that always fails lands in <channel>.dlq with the reason")
    @MethodSource("providers")
    void deadLetter(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        DispatchAdapter watcher = switch (provider) {
            case "redis" -> new RedisStreamsAdapter(new RedisStreamsAdapter.Config(env("PSO_TEST_REDIS_URL"), 10_000, Duration.ofSeconds(60), Duration.ofMillis(300), true));
            case "rabbitmq" -> new RabbitMqAdapter(new RabbitMqAdapter.Config(env("PSO_TEST_RABBITMQ_URL"), "pso."));
            default -> new KafkaAdapter(new KafkaAdapter.Config(List.of(env("PSO_TEST_KAFKA_BROKERS")), "watcher-" + run.substring(0, 6), true, 1, 1, false, null, null, null));
        };
        watcher.connect();
        List<DispatchAdapter.Delivery> seen = new CopyOnWriteArrayList<>();
        try (ConfigurableApplicationContext ctx = run(provider, service())) {
            watcher.subscribe(new DispatchAdapter.Subscription("it-events.dlq", "watch-" + run.substring(0, 8), 1, 5, d -> {
                if (new String(d.body()).contains(run)) {
                    seen.add(d);
                }
                d.ack();
            }));
            ctx.getBean(PsoDispatch.class).publish("it.user-created", event(run, 2, "always-fail"));
            until(() -> !seen.isEmpty(), 60_000);
            assertThat(seen.get(0).headers().get("x-pso-reason")).isEqualTo("handler-failed:IllegalStateException");
            assertThat(seen.get(0).headers().get("x-pso-attempts")).isEqualTo("3");
            assertThat(Envelope.parse(seen.get(0).body()).payload().get("run").asText()).isEqualTo(run);
            // the counter moves just after the dead-letter publish returns, so the watcher can be faster than the runtime
            until(() -> ctx.getBean(PsoDispatch.class).metrics().deadLettered() >= 1, 10_000);
            assertThat(ctx.getBean(PsoDispatch.class).metrics().deadLettered()).isGreaterThanOrEqualTo(1);
        } finally {
            watcher.close();
        }
    }

    @ParameterizedTest(name = "[{0}] publish refuses contract violations before anything reaches the broker")
    @MethodSource("providers")
    void contractIsEnforced(String provider) {
        requireBroker(provider);
        try (ConfigurableApplicationContext ctx = run(provider, service())) {
            PsoDispatch d = ctx.getBean(PsoDispatch.class);
            assertThatThrownBy(() -> d.publish("it.unknown", Map.of())).isInstanceOfSatisfying(DispatchException.class, e -> assertThat(e.code()).isEqualTo("PSO_DISPATCH_UNKNOWN_EVENT"));
            assertThatThrownBy(() -> d.publish("it.user-created", Map.of("run", "x", "n", -1, "mode", "ok"))).isInstanceOfSatisfying(DispatchException.class, e -> assertThat(e.code()).isEqualTo("PSO_DISPATCH_SCHEMA"));
            assertThatThrownBy(() -> d.publish("it.user-created", Map.of("run", "x", "n", 1, "mode", "ok", "extra", true))).isInstanceOfSatisfying(DispatchException.class, e -> assertThat(e.code()).isEqualTo("PSO_DISPATCH_SCHEMA"));
            assertThat(d.metrics().published()).isZero();
        }
    }

    // ------------------------------------------------------------------ TypeScript <-> Java over the same broker

    static Process node(String provider, String mode, Map<String, String> extra) throws Exception {
        File script = new File("../../packages/dispatch/test/crosslang.ts").getCanonicalFile();
        ProcessBuilder pb = new ProcessBuilder("node", script.getPath());
        pb.environment().putAll(System.getenv());
        pb.environment().put("CL_PROVIDER", provider);
        pb.environment().put("CL_MODE", mode);
        pb.environment().putAll(extra);
        pb.redirectErrorStream(true);
        return pb.start();
    }

    static List<String> readUntil(Process p, String marker, long ms) throws Exception {
        List<String> lines = new CopyOnWriteArrayList<>();
        Thread t = Thread.ofVirtual().start(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String l;
                while ((l = r.readLine()) != null) {
                    lines.add(l);
                }
            } catch (java.io.IOException ignored) {
                // process ended
            }
        });
        until(() -> lines.stream().anyMatch(l -> l.startsWith(marker)) || !p.isAlive(), ms);
        t.join(500);
        return lines;
    }

    @ParameterizedTest(name = "[{0}] Java publishes, the TypeScript runtime consumes the same envelope")
    @MethodSource("providers")
    void javaPublishesTypeScriptConsumes(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        String group = "ts-" + run.substring(0, 8);
        Process ts = node(provider, "consume", Map.of("CL_GROUP", group));
        try {
            List<String> out = new CopyOnWriteArrayList<>();
            Thread reader = Thread.ofVirtual().start(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(ts.getInputStream()))) {
                    String l;
                    while ((l = r.readLine()) != null) {
                        out.add(l);
                    }
                } catch (java.io.IOException ignored) {
                    // ended
                }
            });
            until(() -> out.contains("READY") || !ts.isAlive(), 90_000);
            assertThat(out).contains("READY");
            try (ConfigurableApplicationContext ctx = run(provider, "java-" + run.substring(0, 6) + "-service")) {
                var r = ctx.getBean(PsoDispatch.class).publish("it.user-created", event(run, 42, "ok"), new PsoDispatch.PublishInput("corr-java-ts-1", null, null, "evt-" + run.substring(0, 8), 0));
                assertThat(r.id()).isEqualTo("evt-" + run.substring(0, 8));
                until(() -> out.stream().anyMatch(l -> l.startsWith("RECEIVED") && l.contains(run)), 60_000);
            }
            String line = out.stream().filter(l -> l.startsWith("RECEIVED") && l.contains(run)).findFirst().orElseThrow();
            var got = new ObjectMapper().readTree(line.substring("RECEIVED ".length()));
            assertThat(got.get("payload").get("n").asInt()).isEqualTo(42);
            assertThat(got.get("type").asText()).isEqualTo("it.user-created");
            assertThat(got.get("version").asInt()).isEqualTo(1);
            assertThat(got.get("correlationId").asText()).isEqualTo("corr-java-ts-1");
            assertThat(got.get("source").asText()).startsWith("java-");
            assertThat(got.get("id").asText()).isEqualTo("evt-" + run.substring(0, 8));
            reader.interrupt();
        } finally {
            ts.getOutputStream().close();
            ts.destroy();
        }
    }

    @ParameterizedTest(name = "[{0}] the TypeScript runtime publishes, a Spring @PsoEventHandler consumes it")
    @MethodSource("providers")
    void typeScriptPublishesJavaConsumes(String provider) throws Exception {
        requireBroker(provider);
        String run = UUID.randomUUID().toString();
        try (ConfigurableApplicationContext ctx = run(provider, service())) {
            Thread.sleep(provider.equals("kafka") ? 3000 : 500); // let the consumer group join before the message arrives
            Process ts = node(provider, "publish", Map.of("CL_PAYLOAD", new ObjectMapper().writeValueAsString(event(run, 9, "ok")), "CL_CORRELATION", "corr-ts-java-1", "CL_ID", "evt-" + run.substring(0, 8)));
            List<String> out = readUntil(ts, "PUBLISHED", 90_000);
            assertThat(out).anyMatch(l -> l.startsWith("PUBLISHED " + provider));
            DispatchApp.Handlers h = ctx.getBean(DispatchApp.Handlers.class);
            until(() -> h.seen.stream().anyMatch(s -> s.startsWith(run + ":9")), 60_000);
        }
    }
}
