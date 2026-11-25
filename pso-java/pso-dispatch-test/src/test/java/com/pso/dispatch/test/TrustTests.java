package com.pso.dispatch.test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.DispatchAdapter.PublishOptions;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.Events;
import com.pso.dispatch.Trust;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;

/**
 * Trusted service identity for Dispatch (the Java half of packages/dispatch/test/trust.test.ts): the envelope's source is a claim, a
 * signature made with that service's key is the proof. The signature fixtures are shared with TypeScript, so both runtimes are shown to
 * produce and accept exactly the same bytes.
 */
class TrustTests {

    static final ObjectMapper M = new ObjectMapper();
    static final String BILLING = "billing-key-" + "b".repeat(28), USERS = "users-key-" + "u".repeat(30), ROGUE = "rogue-key-" + "r".repeat(30), BILLING_OLD = "billing-old-" + "o".repeat(28);
    static final String CHANNEL = "billing.events";

    record Seen(String invoice, String claimed, String verified) {
    }

    record Svc(DispatchRuntime rt, List<Seen> seen) {
    }

    static Svc service(MemoryAdapter bus, String source, Trust trust, String channel) {
        Events.Registry reg = new Events.Registry();
        reg.add(new Events.Decl("billing.invoice-paid", 1, channel, null, "full", List.of(), true, null));
        DispatchRuntime rt = new DispatchRuntime(new DispatchRuntime.Settings(source, 1, 10, true, 2, 1, 2, 1.0, true, Envelope.MAX_BYTES, 24L * 3600_000, 3000), bus, reg, null, M, trust);
        return new Svc(rt, new CopyOnWriteArrayList<>());
    }

    static Svc service(MemoryAdapter bus, String source, Trust trust) {
        return service(bus, source, trust, CHANNEL);
    }

    static void consume(Svc s, String group) {
        s.rt.register("billing.invoice-paid", group, 0, (JsonNode p, ConsumeContext c) -> s.seen.add(new Seen(p.get("invoice").asText(), c.envelope().source(), c.verifiedSource())));
    }

    static Trust signing(String key) {
        return new Trust(Trust.Mode.OFF, key, Map.of());
    }

    static Trust verifying(Trust.Mode mode, Map<String, List<String>> keys) {
        return new Trust(mode, null, keys);
    }

    static void until(BooleanSupplier c) throws Exception {
        long end = System.currentTimeMillis() + 5000;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) {
                throw new AssertionError("timeout waiting for condition");
            }
            Thread.sleep(5);
        }
    }

    static List<String> reasons(MemoryAdapter bus, String channel) {
        return bus.messages(channel + ".dlq").stream().map(m -> m.headers().get("x-pso-reason")).toList();
    }

    @Test
    void signatureFixturesSharedWithTypeScript() throws Exception {
        JsonNode fx = M.readTree(new File("../../fixtures/contracts/dispatch/signatures.json"));
        assertThat(fx.get("header").asText()).isEqualTo(Trust.HEADER);
        assertThat(fx.get("cases")).isNotEmpty();
        for (JsonNode c : fx.get("cases")) {
            byte[] body = c.get("body").asText().getBytes(StandardCharsets.UTF_8);
            String key = c.get("key").asText(), channel = c.get("channel").asText(), name = c.get("name").asText();
            assertThat(Trust.sign(key, channel, body)).as(name + ": Java produces the signature TypeScript produced").isEqualTo(c.get("signature").asText());
            Trust t = verifying(Trust.Mode.REQUIRED, Map.of("some-service", List.of(key)));
            assertThat(t.verify(channel, body, c.get("signature").asText(), "some-service")).as(name).isEqualTo(Trust.Verdict.VERIFIED);
            assertThat(t.verify(channel + "x", body, c.get("signature").asText(), "some-service")).as(name + " on another channel").isEqualTo(Trust.Verdict.INVALID);
        }
    }

    @Test
    void theSignatureVerifiesOnlyWithTheClaimedSourcesKey() {
        byte[] body = "{\"envelopeVersion\":1,\"id\":\"a\"}".getBytes(StandardCharsets.UTF_8);
        String sig = Trust.sign(BILLING, CHANNEL, body);
        assertThat(sig).matches("^v1=[A-Za-z0-9_-]{43}$");
        Trust t = verifying(Trust.Mode.REQUIRED, Map.of("billing-service", List.of(BILLING), "users-service", List.of(USERS)));
        assertThat(t.verify(CHANNEL, body, sig, "billing-service")).isEqualTo(Trust.Verdict.VERIFIED);
        assertThat(t.verify(CHANNEL, body, sig, "users-service")).as("billing's signature does not prove users-service sent it").isEqualTo(Trust.Verdict.INVALID);
        assertThat(t.verify(CHANNEL, "{\"envelopeVersion\":1,\"id\":\"b\"}".getBytes(StandardCharsets.UTF_8), sig, "billing-service")).isEqualTo(Trust.Verdict.INVALID);
        assertThat(t.verify(CHANNEL, body, null, "billing-service")).isEqualTo(Trust.Verdict.UNSIGNED);
        assertThat(t.verify(CHANNEL, body, "", "billing-service")).isEqualTo(Trust.Verdict.UNSIGNED);
        assertThat(t.verify(CHANNEL, body, sig, "payments-service")).isEqualTo(Trust.Verdict.UNKNOWN_SOURCE);
        for (String bad : List.of("v2=" + sig.substring(3), sig.substring(3), "v1=", "v1=AAAA", "v1=" + "A".repeat(400), sig + "x", "v1=!!!not-base64!!!")) {
            assertThat(t.verify(CHANNEL, body, bad, "billing-service")).as(bad.substring(0, Math.min(20, bad.length()))).isEqualTo(Trust.Verdict.INVALID);
        }
        assertThat(verifying(Trust.Mode.REQUIRED, Map.of("billing-service", List.of(BILLING_OLD, BILLING))).verify(CHANNEL, body, sig, "billing-service")).as("rotation").isEqualTo(Trust.Verdict.VERIFIED);
    }

    @Test
    void aSignedMessageIsConsumedAndTheHandlerLearnsWhoWasVerified() throws Exception {
        MemoryAdapter bus = new MemoryAdapter();
        Svc billing = service(bus, "billing-service", signing(BILLING));
        Svc orders = service(bus, "orders-service", verifying(Trust.Mode.REQUIRED, Map.of("billing-service", List.of(BILLING))));
        consume(orders, "orders");
        billing.rt.start();
        orders.rt.start();
        billing.rt.publish("billing.invoice-paid", Map.of("invoice", "inv-1"));
        until(() -> orders.seen.size() == 1);
        assertThat(orders.seen).containsExactly(new Seen("inv-1", "billing-service", "billing-service"));
        assertThat(bus.messages(CHANNEL).get(0).headers().get(Trust.HEADER)).startsWith("v1=");
        assertThat(orders.rt.untrusted()).isZero();
        assertThat(orders.rt.unverified()).isZero();
        billing.rt.stop();
        orders.rt.stop();
    }

    @Test
    void forgedSourceUnsignedUnknownAndTamperedMessagesAreDeadLetteredUnprocessed() throws Exception {
        MemoryAdapter bus = new MemoryAdapter();
        Svc orders = service(bus, "orders-service", verifying(Trust.Mode.REQUIRED, Map.of("billing-service", List.of(BILLING), "rogue-service", List.of(ROGUE))));
        consume(orders, "orders");
        orders.rt.start();
        Svc forger = service(bus, "billing-service", signing(ROGUE));      // signs with ITS key, claims billing-service
        Svc honest = service(bus, "rogue-service", signing(ROGUE));
        Svc unsigned = service(bus, "billing-service", Trust.OFF);
        Svc stranger = service(bus, "payments-service", signing(USERS));  // signed, but nobody gave us its key
        Svc billing = service(bus, "billing-service", signing(BILLING));
        for (Svc s : List.of(forger, honest, unsigned, stranger, billing)) {
            s.rt.start();
        }
        forger.rt.publish("billing.invoice-paid", Map.of("invoice", "forged"));
        until(() -> reasons(bus, CHANNEL).size() == 1);
        honest.rt.publish("billing.invoice-paid", Map.of("invoice", "honest"));
        until(() -> orders.seen.size() == 1);
        unsigned.rt.publish("billing.invoice-paid", Map.of("invoice", "unsigned"));
        until(() -> reasons(bus, CHANNEL).size() == 2);
        stranger.rt.publish("billing.invoice-paid", Map.of("invoice", "stranger"));
        until(() -> reasons(bus, CHANNEL).size() == 3);
        billing.rt.publish("billing.invoice-paid", Map.of("invoice", "good"));
        until(() -> orders.seen.size() == 2);
        // tampering: the genuine signature attached to different content
        MemoryAdapter.Message genuine = bus.messages(CHANNEL).get(bus.messages(CHANNEL).size() - 1);
        byte[] tampered = new String(genuine.body(), StandardCharsets.UTF_8).replace("\"good\"", "\"evil\"").replaceFirst("\"id\":\"[^\"]+\"", "\"id\":\"tampered-1\"").getBytes(StandardCharsets.UTF_8);
        bus.publishRaw(CHANNEL, tampered, new PublishOptions(null, 0, genuine.headers()));
        until(() -> reasons(bus, CHANNEL).size() == 4);
        assertThat(orders.seen).containsExactly(new Seen("honest", "rogue-service", "rogue-service"), new Seen("good", "billing-service", "billing-service"));
        assertThat(reasons(bus, CHANNEL)).containsExactly("PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:unsigned", "PSO_DISPATCH_UNTRUSTED:unknown-source", "PSO_DISPATCH_UNTRUSTED:invalid");
        assertThat(orders.rt.untrusted()).isEqualTo(4);
        assertThat(orders.rt.metrics().retried()).as("never retried: retrying cannot make a message authentic").isZero();
        // a replay of the genuine message on another channel
        Svc auditor = service(bus, "audit-service", verifying(Trust.Mode.REQUIRED, Map.of("billing-service", List.of(BILLING))), "audit.events");
        consume(auditor, "audit");
        auditor.rt.start();
        bus.publishRaw("audit.events", genuine.body(), new PublishOptions(null, 0, genuine.headers()));
        until(() -> reasons(bus, "audit.events").size() == 1);
        assertThat(auditor.seen).isEmpty();
        for (Svc s : List.of(orders, forger, honest, unsigned, stranger, billing, auditor)) {
            s.rt.stop();
        }
    }

    @Test
    void existingDeploymentsAreUntouchedAndPermissiveModeMigratesWithoutLosingTraffic() throws Exception {
        // OFF (the default, and the 5-argument constructor): nothing signed, nothing checked, the context is what it always was
        MemoryAdapter legacy = new MemoryAdapter();
        Events.Registry reg = new Events.Registry();
        reg.add(new Events.Decl("billing.invoice-paid", 1, CHANNEL, null, "full", List.of(), true, null));
        DispatchRuntime old = new DispatchRuntime(new DispatchRuntime.Settings("billing-service"), legacy, reg, null, M);
        List<ConsumeContext> contexts = new CopyOnWriteArrayList<>();
        old.register("billing.invoice-paid", "self", 0, (p, c) -> contexts.add(c));
        old.start();
        old.publish("billing.invoice-paid", Map.of("invoice", "legacy"));
        until(() -> contexts.size() == 1);
        assertThat(legacy.messages(CHANNEL).get(0).headers()).as("no header without a key").isEmpty();
        assertThat(contexts.get(0).verifiedSource()).isNull();
        assertThat(new ConsumeContext(contexts.get(0).envelope(), 1, "g")).as("the 3-argument constructor still exists").isEqualTo(new ConsumeContext(contexts.get(0).envelope(), 1, "g", null));
        assertThat(old.trust().mode()).isEqualTo(Trust.Mode.OFF);
        old.stop();

        MemoryAdapter bus = new MemoryAdapter();
        Svc orders = service(bus, "orders-service", verifying(Trust.Mode.PERMISSIVE, Map.of("billing-service", List.of(BILLING))));
        consume(orders, "orders");
        Svc notUpgraded = service(bus, "billing-service", Trust.OFF), upgraded = service(bus, "billing-service", signing(BILLING)), forger = service(bus, "billing-service", signing(ROGUE));
        for (Svc s : List.of(orders, notUpgraded, upgraded, forger)) {
            s.rt.start();
        }
        notUpgraded.rt.publish("billing.invoice-paid", Map.of("invoice", "not-yet-upgraded"));
        until(() -> orders.seen.size() == 1);
        upgraded.rt.publish("billing.invoice-paid", Map.of("invoice", "upgraded"));
        until(() -> orders.seen.size() == 2);
        forger.rt.publish("billing.invoice-paid", Map.of("invoice", "forged"));
        until(() -> reasons(bus, CHANNEL).size() == 1);
        assertThat(orders.seen).containsExactly(new Seen("not-yet-upgraded", "billing-service", null), new Seen("upgraded", "billing-service", "billing-service"));
        assertThat(orders.rt.unverified()).as("the migration counter").isEqualTo(1);
        assertThat(orders.rt.untrusted()).isEqualTo(1);
        for (Svc s : List.of(orders, notUpgraded, upgraded, forger)) {
            s.rt.stop();
        }
    }

    @Test
    void aServiceVerifiesItsOwnEventsAndConfigurationRefusesWeakKeysWithoutEchoingThem() throws Exception {
        MemoryAdapter bus = new MemoryAdapter();
        Svc self = service(bus, "billing-service", new Trust(Trust.Mode.REQUIRED, BILLING, Map.of("billing-service", List.of(BILLING_OLD))));
        consume(self, "billing");
        Svc stillOld = service(bus, "billing-service", signing(BILLING_OLD));
        self.rt.start();
        stillOld.rt.start();
        self.rt.publish("billing.invoice-paid", Map.of("invoice", "new-key"));
        until(() -> self.seen.size() == 1);
        stillOld.rt.publish("billing.invoice-paid", Map.of("invoice", "old-key"));
        until(() -> self.seen.size() == 2);
        assertThat(self.seen.stream().map(Seen::verified).toList()).containsExactly("billing-service", "billing-service");
        self.rt.stop();
        stillOld.rt.stop();

        assertThatThrownBy(() -> new Trust(Trust.Mode.REQUIRED, "short-signing-key", Map.of())).hasMessageContaining("at least 32 characters").hasMessageNotContaining("short-signing-key");
        assertThatThrownBy(() -> new Trust(Trust.Mode.REQUIRED, null, Map.of("billing-service", List.of("short-trust-key")))).hasMessageContaining("\"billing-service\"").hasMessageNotContaining("short-trust-key");
        assertThatThrownBy(() -> Trust.Mode.of("strictest")).hasMessageContaining("off, permissive, required");
        assertThat(Trust.Mode.of(null)).isEqualTo(Trust.Mode.OFF);
        assertThat(Trust.keysFromEnvironment(Map.of("PSO_DISPATCH_TRUST_KEY_USERS_SERVICE", USERS + ", " + BILLING, "PSO_DISPATCH_SIGNING_KEY", BILLING, "PATH", "x")))
            .isEqualTo(Map.of("users-service", List.of(USERS, BILLING)));
    }
}
