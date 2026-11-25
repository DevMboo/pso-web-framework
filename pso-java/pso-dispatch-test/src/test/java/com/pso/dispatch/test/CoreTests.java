package com.pso.dispatch.test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.Events;
import com.pso.dispatch.IdempotencyStore;
import com.pso.dispatch.PsoDispatch;
import com.pso.dispatch.Schemas;
import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;

class CoreTests {

    static final ObjectMapper M = new ObjectMapper();

    static JsonNode fixture(String name) throws Exception {
        return M.readTree(new File("../../fixtures/contracts/dispatch/" + name));
    }

    @Test
    void envelopeFixturesSharedWithTypeScript() throws Exception {
        JsonNode fx = fixture("envelopes.json");
        for (JsonNode v : fx.get("valid")) {
            String name = v.get("name").asText();
            assertThat(Envelope.problems(v.get("envelope"))).as(name).isEmpty();
            byte[] canonical = v.get("canonical").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            Envelope parsed = Envelope.parse(canonical);
            assertThat(parsed.serialize()).as(name + ": Java reproduces the exact canonical bytes TypeScript produced").isEqualTo(v.get("canonical").asText());
            assertThat(parsed.toTree()).as(name + " round trip").isEqualTo(v.get("envelope"));
        }
        for (JsonNode i : fx.get("invalid")) {
            assertThat(Envelope.problems(i.get("envelope"))).as(i.get("name").asText()).isNotEmpty();
        }
    }

    @Test
    void envelopeLimits() {
        Envelope e = Envelope.create("users.created", 1, "users-service", M.createObjectNode().put("a", 1), null, null, null, null);
        assertThatThrownBy(() -> Envelope.parse(e.bytes(), 10)).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_ENVELOPE_TOO_LARGE"));
        assertThatThrownBy(() -> Envelope.parse("{not json".getBytes(), 1000)).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_ENVELOPE_INVALID"));
        com.fasterxml.jackson.databind.node.ObjectNode deep = M.createObjectNode();
        com.fasterxml.jackson.databind.node.ObjectNode cur = deep;
        for (int i = 0; i < 40; i++) {
            cur = cur.putObject("d");
        }
        assertThat(Envelope.problems(new Envelope("a", "users.created", 1, "s-service", "2026-11-07T12:00:00.000Z", "c", null, null, deep).toTree())).anyMatch(p -> p.contains("deeply"));
        assertThat(e.occurredAt()).endsWith("Z");
    }

    @Test
    void schemaFixturesSharedWithTypeScript() throws Exception {
        JsonNode fx = fixture("schema-cases.json");
        assertThat(Schemas.problems(fx.get("schema"), "$")).isEmpty();
        for (JsonNode c : fx.get("cases")) {
            assertThat(Schemas.validate(fx.get("schema"), c.get("value"), "$").isEmpty()).as(c.get("value").toString()).isEqualTo(c.get("valid").asBoolean());
        }
        assertThat(Schemas.problems(M.readTree("{\"type\":\"object\",\"oneOf\":[]}"), "$")).anyMatch(p -> p.contains("unsupported keyword \"oneOf\""));
    }

    // ------------------------------------------------------------ runtime with the in-memory adapter (a contract test, not a broker test)

    static DispatchRuntime.Settings settings(int attempts, boolean dlq) {
        return new DispatchRuntime.Settings("users-service", 1, 10, true, attempts, 1, 4, 2.0, dlq, Envelope.MAX_BYTES, 24L * 3600_000, 5000);
    }

    static Events.Decl decl(String name, int version, String channel, String schema, boolean publish, List<Integer> accepts) throws Exception {
        return new Events.Decl(name, version, channel, schema == null ? null : M.readTree(schema), "full", accepts, publish, null);
    }

    static final String SCHEMA = "{\"type\":\"object\",\"required\":[\"userId\"],\"properties\":{\"userId\":{\"type\":\"string\"}}}";

    record Env(DispatchRuntime rt, MemoryAdapter adapter) {
    }

    static Env env(DispatchRuntime.Settings s, Events.Decl... decls) {
        Events.Registry reg = new Events.Registry();
        for (Events.Decl d : decls) {
            reg.add(d);
        }
        MemoryAdapter a = new MemoryAdapter();
        return new Env(new DispatchRuntime(s, a, reg, null, M), a);
    }

    static void until(BooleanSupplier c) throws Exception {
        long end = System.currentTimeMillis() + 5000;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) {
                throw new AssertionError("timeout");
            }
            Thread.sleep(5);
        }
    }

    @Test
    void publishValidatesTheContract() throws Exception {
        Env e = env(settings(3, true), decl("users.created", 1, "users.events", SCHEMA, true, null), decl("orders.paid", 1, "orders.events", null, false, null));
        e.rt.start();
        assertThatThrownBy(() -> e.rt.publish("nope.event", Map.of())).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_UNKNOWN_EVENT"));
        assertThatThrownBy(() -> e.rt.publish("orders.paid", Map.of())).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_NOT_PUBLISHER"));
        assertThatThrownBy(() -> e.rt.publish("users.created", Map.of("userId", 5))).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_SCHEMA"));
        assertThat(e.adapter.log).isEmpty();
        var r = e.rt.publish("users.created", Map.of("userId", "1"), new PsoDispatch.PublishInput("corr-1", null, null, null, 0));
        assertThat(r.provider()).isEqualTo("memory");
        assertThat(r.acknowledgement()).contains("not durable");
        Envelope sent = Envelope.parse(e.adapter.messages("users.events").get(0).body());
        assertThat(List.of(sent.type(), String.valueOf(sent.version()), sent.source(), sent.correlationId())).containsExactly("users.created", "1", "users-service", "corr-1");
        e.rt.stop();
    }

    @Test
    void consumeRetryAndDeadLetter() throws Exception {
        Env e = env(settings(3, true), decl("users.created", 1, "users.events", SCHEMA, true, null));
        AtomicInteger calls = new AtomicInteger();
        e.rt.register("users.created", null, 0, (p, c) -> {
            calls.incrementAndGet();
            throw new IllegalStateException("always");
        });
        e.rt.start();
        e.rt.publish("users.created", Map.of("userId", "1"));
        until(() -> e.rt.metrics().deadLettered() == 1);
        assertThat(calls.get()).isEqualTo(3);
        List<MemoryAdapter.Message> dlq = e.adapter.messages("users.events.dlq");
        assertThat(dlq).hasSize(1);
        assertThat(dlq.get(0).headers().get("x-pso-reason")).isEqualTo("handler-failed:IllegalStateException");
        assertThat(dlq.get(0).headers().get("x-pso-attempts")).isEqualTo("3");
        assertThat(Envelope.parse(dlq.get(0).body()).payload().get("userId").asText()).isEqualTo("1");
        e.rt.stop();
    }

    @Test
    void retrySucceedsAndSuccessAcknowledges() throws Exception {
        Env e = env(settings(3, true), decl("users.created", 1, "users.events", SCHEMA, true, null));
        AtomicInteger calls = new AtomicInteger();
        e.rt.register("users.created", null, 0, (p, c) -> {
            if (calls.incrementAndGet() < 3) {
                throw new IllegalStateException("transient");
            }
        });
        e.rt.start();
        e.rt.publish("users.created", Map.of("userId", "1"));
        until(() -> e.rt.metrics().consumed() == 1);
        assertThat(calls.get()).isEqualTo(3);
        assertThat(e.rt.metrics().retried()).isEqualTo(2);
        assertThat(e.rt.metrics().deadLettered()).isZero();
        e.rt.stop();
    }

    @Test
    void poisonMessagesAreDeadLetteredWithoutRunningTheHandler() throws Exception {
        Env e = env(settings(3, true), decl("users.created", 1, "users.events", SCHEMA, true, null));
        AtomicInteger calls = new AtomicInteger();
        e.rt.register("users.created", null, 0, (p, c) -> calls.incrementAndGet());
        e.rt.start();
        e.adapter.publishRaw("users.events", "garbage".getBytes(), com.pso.dispatch.DispatchAdapter.PublishOptions.none());
        e.adapter.publishRaw("users.events", Envelope.create("users.created", 9, "x-service", M.createObjectNode().put("userId", "1"), null, null, null, null).bytes(), com.pso.dispatch.DispatchAdapter.PublishOptions.none());
        e.adapter.publishRaw("users.events", Envelope.create("users.created", 1, "x-service", M.createObjectNode().put("userId", 7), null, null, null, null).bytes(), com.pso.dispatch.DispatchAdapter.PublishOptions.none());
        until(() -> e.rt.metrics().deadLettered() == 3);
        assertThat(calls.get()).isZero();
        assertThat(e.adapter.messages("users.events.dlq").stream().map(m -> m.headers().get("x-pso-reason")).sorted().toList())
            .containsExactly("PSO_DISPATCH_ENVELOPE_INVALID", "PSO_DISPATCH_SCHEMA", "PSO_DISPATCH_UNSUPPORTED_VERSION");
        e.rt.stop();
    }

    @Test
    void idempotencyHandlesAnEventIdOncePerGroup() throws Exception {
        Events.Registry reg = new Events.Registry();
        reg.add(decl("users.created", 1, "users.events", null, true, null));
        long[] clock = {0};
        DispatchRuntime rt = new DispatchRuntime(settings(3, true), new MemoryAdapter(), reg, new IdempotencyStore.Memory(100, () -> clock[0]), M);
        AtomicInteger calls = new AtomicInteger();
        rt.register("users.created", null, 0, (p, c) -> calls.incrementAndGet());
        rt.start();
        rt.publish("users.created", Map.of("n", 1), new PsoDispatch.PublishInput(null, null, null, "evt-1", 0));
        rt.publish("users.created", Map.of("n", 1), new PsoDispatch.PublishInput(null, null, null, "evt-1", 0));
        until(() -> rt.metrics().consumed() + rt.metrics().duplicates() == 2);
        assertThat(calls.get()).isEqualTo(1);
        clock[0] += 25L * 3600_000;
        rt.publish("users.created", Map.of("n", 1), new PsoDispatch.PublishInput(null, null, null, "evt-1", 0));
        until(() -> calls.get() == 2);
        rt.stop();
    }

    @Test
    void deadLetterPublishFailureLeavesTheMessageUnacknowledged() throws Exception {
        Env e = env(settings(1, true), decl("users.created", 1, "users.events", null, true, null));
        AtomicInteger calls = new AtomicInteger();
        e.adapter.failDeadLetter.set(new IllegalStateException("dlq down"));
        e.rt.register("users.created", null, 0, (p, c) -> {
            if (calls.incrementAndGet() >= 3) {
                e.adapter.failDeadLetter.set(null);
            }
            throw new IllegalStateException("x");
        });
        e.rt.start();
        e.rt.publish("users.created", Map.of("n", 1));
        until(() -> e.rt.metrics().deadLettered() == 1);
        assertThat(calls.get()).as("redelivered until the dead-letter destination worked").isGreaterThanOrEqualTo(3);
        e.rt.stop();
    }

    @Test
    void deadLetterDisabledDropsAndCounts() throws Exception {
        Env e = env(new DispatchRuntime.Settings("users-service", 1, 10, false, 1, 1, 1, 1.0, false, Envelope.MAX_BYTES, 1000, 5000), decl("users.created", 1, "users.events", null, true, null));
        e.rt.register("users.created", null, 0, (p, c) -> {
            throw new IllegalStateException("x");
        });
        e.rt.start();
        e.rt.publish("users.created", Map.of("n", 1));
        until(() -> e.rt.metrics().dropped() == 1);
        e.rt.stop();
    }

    @Test
    void gracefulShutdownLetsInFlightMessagesFinish() throws Exception {
        Env e = env(settings(5, true), decl("users.created", 1, "users.events", null, true, null));
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        e.rt.register("users.created", null, 0, (p, c) -> {
            started.countDown();
            release.await();
        });
        e.rt.start();
        e.rt.publish("users.created", Map.of("n", 1));
        assertThat(started.await(3, TimeUnit.SECONDS)).isTrue();
        Thread stopper = Thread.ofVirtual().start(e.rt::stop);
        Thread.sleep(30);
        release.countDown();
        stopper.join(5000);
        assertThat(e.rt.metrics().consumed()).isEqualTo(1);
        assertThat(e.adapter.messages("users.events.dlq")).isEmpty();
    }

    @Test
    void consumersMustBeDeclaredAndRegisteredBeforeStart() throws Exception {
        Env e = env(settings(3, true), decl("users.created", 1, "users.events", null, true, null));
        assertThatThrownBy(() -> e.rt.register("other.event", null, 0, (p, c) -> { })).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_CONSUMER"));
        e.rt.start();
        assertThatThrownBy(() -> e.rt.register("users.created", null, 0, (p, c) -> { })).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_STATE"));
        e.rt.stop();
    }

    @Test
    void disabledDispatchFailsClearlyAndConnectsNothing() {
        PsoDispatch d = new PsoDispatch.Disabled();
        assertThatThrownBy(() -> d.publish("users.created", Map.of())).isInstanceOfSatisfying(DispatchException.class, x -> assertThat(x.code()).isEqualTo("PSO_DISPATCH_DISABLED"));
        assertThat(d.health().up()).isFalse();
    }

    @Test
    void declarationsAreValidated() {
        assertThat(Events.problems(new Events.Decl("Users.Created", 1, "c", null, null, null, true, null))).anyMatch(p -> p.contains("invalid name"));
        assertThat(Events.problems(new Events.Decl("a.b", 0, "c", null, null, null, true, null))).anyMatch(p -> p.contains("version"));
        assertThat(Events.problems(new Events.Decl("a.b", 1, "c", null, null, List.of(1), true, null))).anyMatch(p -> p.contains("accepts"));
        Events.Registry r = new Events.Registry();
        r.add(new Events.Decl("a.b", 1, "c", null, null, null, true, null));
        assertThatThrownBy(() -> r.add(new Events.Decl("a.b", 1, "c", null, null, null, true, null))).isInstanceOf(DispatchException.class);
        assertThatThrownBy(() -> r.add(new Events.Decl("a.b", 2, "d", null, null, null, true, null))).isInstanceOf(DispatchException.class);
    }
}
