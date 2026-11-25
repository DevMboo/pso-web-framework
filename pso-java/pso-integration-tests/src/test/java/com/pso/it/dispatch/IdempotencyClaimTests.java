package com.pso.it.dispatch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.Events;
import com.pso.dispatch.IdempotencyStore;
import com.pso.dispatch.IdempotencyStore.Claim;
import com.pso.dispatch.redis.RedisStreamsAdapter;
import com.pso.dispatch.test.MemoryAdapter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Concurrent consumers and the idempotency claim (REL-01), the Java runtime. The same event id delivered to several runtime instances
 * at the same moment runs the handler once; a claim of a consumer that died expires; an owner never completes or releases a claim
 * that is no longer its own. "redis" runs against the real Redis of scripts/dispatch-brokers.mjs (skipped without it) with one
 * store object and connection per instance, as separate processes would have. The guarantee stays at-least-once.
 */
class IdempotencyClaimTests {

    static final ObjectMapper M = new ObjectMapper();
    private final List<AutoCloseable> opened = new ArrayList<>();

    @AfterEach
    void close() throws Exception {
        for (AutoCloseable c : opened) {
            c.close();
        }
    }

    /** A transport reduced to what these tests need: deliver(body) hands one message to the subscribed runtime and counts ack / nack. */
    static final class Direct implements DispatchAdapter {
        volatile Subscription sub;
        final AtomicInteger acks = new AtomicInteger(), nacks = new AtomicInteger(), dead = new AtomicInteger();

        @Override
        public Capabilities capabilities() {
            return new MemoryAdapter().capabilities();
        }

        @Override
        public void connect() {
        }

        @Override
        public PublishResult publish(String channel, Envelope envelope, PublishOptions options) {
            throw new UnsupportedOperationException();
        }

        @Override
        public PublishResult publishRaw(String channel, byte[] body, PublishOptions options) {
            dead.incrementAndGet();
            return new PublishResult("x", channel, "memory", "0", "test");
        }

        @Override
        public SubscriptionHandle subscribe(Subscription s) {
            sub = s;
            return t -> { };
        }

        @Override
        public Health health() {
            return new Health(true, "test");
        }

        @Override
        public void close() {
        }

        void deliver(byte[] body) throws Exception {
            sub.handler().onMessage(new Delivery() {
                @Override
                public String channel() {
                    return sub.channel();
                }

                @Override
                public byte[] body() {
                    return body;
                }

                @Override
                public Map<String, String> headers() {
                    return Map.of();
                }

                @Override
                public void ack() {
                    acks.incrementAndGet();
                }

                @Override
                public void nack() {
                    nacks.incrementAndGet();
                }
            });
        }
    }

    record Instance(DispatchRuntime rt, Direct tx) {
    }

    Supplier<IdempotencyStore> stores(String kind) {
        if (kind.equals("memory")) {
            IdempotencyStore shared = new IdempotencyStore.Memory();
            return () -> shared;
        }
        String url = System.getenv("PSO_TEST_REDIS_URL");
        assumeTrue(url != null, "no real redis available (run: node scripts/dispatch-brokers.mjs up)");
        String prefix = "pso:test:idem:" + UUID.randomUUID() + ":";
        return () -> {
            RedisStreamsAdapter.Idempotency s = new RedisStreamsAdapter.Idempotency(url, prefix);
            opened.add(s);
            return s;
        };
    }

    Instance instance(IdempotencyStore store, DispatchRuntime.Handler handler, Duration lease) {
        Events.Registry reg = new Events.Registry();
        reg.add(new Events.Decl("t.event", 1, "c", null, "full", null, true, null));
        Direct tx = new Direct();
        DispatchRuntime rt = new DispatchRuntime(new DispatchRuntime.Settings("svc-service", 1, 10, false, 1, 1, 1, 1.0, true, Envelope.MAX_BYTES, 24L * 3600_000, 2000), tx, reg, store, M);
        if (lease != null) {
            rt.idempotencyLease(lease);
        }
        rt.register("t.event", "g", 0, handler);
        rt.start();
        return new Instance(rt, tx);
    }

    static byte[] event(String id) {
        return Envelope.create("t.event", 1, "svc-service", M.createObjectNode().put("n", 1), null, null, null, id).bytes();
    }

    @ParameterizedTest(name = "[{0}] the same event delivered to 2 and to 10 consumers at the same moment runs the handler once")
    @ValueSource(strings = {"memory", "redis"})
    void simultaneousConsumers(String kind) throws Exception {
        for (int n : new int[] {2, 10}) {
            Supplier<IdempotencyStore> store = stores(kind);
            AtomicInteger entered = new AtomicInteger(), running = new AtomicInteger(), overlap = new AtomicInteger();
            DispatchRuntime.Handler handler = (p, c) -> {
                entered.incrementAndGet();
                overlap.accumulateAndGet(running.incrementAndGet(), Math::max);
                Thread.sleep(150);
                running.decrementAndGet();
            };
            List<Instance> all = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                all.add(instance(store.get(), handler, null));
            }
            byte[] body = event("evt-" + UUID.randomUUID());
            ExecutorService pool = Executors.newFixedThreadPool(n);
            CountDownLatch go = new CountDownLatch(1);
            List<java.util.concurrent.Future<?>> done = new ArrayList<>();
            for (Instance x : all) {
                done.add(pool.submit(() -> {
                    go.await();
                    x.tx().deliver(body);
                    return null;
                }));
            }
            go.countDown();
            for (java.util.concurrent.Future<?> f : done) {
                f.get(30, TimeUnit.SECONDS);
            }
            pool.shutdown();
            assertThat(entered.get()).as(n + " simultaneous deliveries: handler runs").isEqualTo(1);
            assertThat(overlap.get()).isEqualTo(1);
            assertThat(all.stream().mapToInt(x -> x.tx().acks.get()).sum()).as("every delivery acknowledged: one handled, the others as duplicates").isEqualTo(n);
            assertThat(all.stream().mapToLong(x -> x.rt().metrics().duplicates()).sum()).isEqualTo(n - 1);
            all.get(0).tx().deliver(body); // a later redelivery is a duplicate as before
            assertThat(entered.get()).isEqualTo(1);
            for (Instance x : all) {
                x.rt().stop();
            }
        }
    }

    @ParameterizedTest(name = "[{0}] failed handler releases its claim; a dead consumer's claim expires; ownership is enforced; Node's records are understood")
    @ValueSource(strings = {"memory", "redis"})
    void failureRecoveryAndOwnership(String kind) throws Exception {
        Supplier<IdempotencyStore> store = stores(kind);
        // a failed handler gives the claim back: the dead-lettered event can be replayed and handled
        AtomicInteger calls = new AtomicInteger();
        boolean[] fail = {true};
        Instance a = instance(store.get(), (p, c) -> {
            calls.incrementAndGet();
            if (fail[0]) {
                throw new IllegalStateException("boom");
            }
        }, null);
        byte[] body = event("evt-" + UUID.randomUUID());
        a.tx().deliver(body);
        assertThat(calls.get()).isEqualTo(1);
        assertThat(a.tx().dead.get()).isEqualTo(1);
        fail[0] = false;
        a.tx().deliver(body);
        assertThat(calls.get()).as("handled on the legitimate retry").isEqualTo(2);
        a.tx().deliver(body);
        assertThat(calls.get()).as("and only now a duplicate").isEqualTo(2);
        a.rt().stop();

        // crash after claim: nobody renews, nobody completes; the survivor handles the event after the lease
        String id = "evt-" + UUID.randomUUID();
        assertThat(store.get().claim("g:" + id, "dead-consumer", 400)).isEqualTo(Claim.CLAIMED);
        AtomicInteger survivor = new AtomicInteger();
        Instance b = instance(store.get(), (p, c) -> survivor.incrementAndGet(), Duration.ofMillis(400));
        long started = System.currentTimeMillis();
        b.tx().deliver(event(id));
        assertThat(survivor.get()).isEqualTo(1);
        assertThat(System.currentTimeMillis() - started).isBetween(250L, 5000L);
        b.rt().stop();

        // ownership
        IdempotencyStore s = store.get();
        assertThat(s.claim("k", "A", 150)).isEqualTo(Claim.CLAIMED);
        assertThat(s.claim("k", "B", 150)).isEqualTo(Claim.BUSY);
        assertThat(s.renew("k", "B", 150)).isFalse();
        Thread.sleep(250);
        assertThat(s.renew("k", "A", 150)).as("an expired lease cannot be renewed").isFalse();
        assertThat(s.claim("k", "B", 5000)).isEqualTo(Claim.CLAIMED);
        assertThat(s.complete("k", "A", 60_000)).as("the stale owner is told it lost the claim").isFalse();
        s.release("k", "A");
        assertThat(s.claim("k", "C", 5000)).as("the stale owner's release did not remove B's claim").isEqualTo(Claim.BUSY);
        assertThat(s.complete("k", "B", 60_000)).isTrue();
        assertThat(s.claim("k", "C", 5000)).isEqualTo(Claim.DONE);
        assertThat(s.has("k")).isTrue();
        // a record written by add() (earlier versions, and what the Node runtime writes on completion) is a completion to claim()
        s.add("old", 60_000);
        assertThat(s.claim("old", "X", 1000)).isEqualTo(Claim.DONE);
    }

    @ParameterizedTest(name = "[{0}] a handler that runs for several lease periods keeps its claim: a second delivery never overlaps it")
    @ValueSource(strings = {"memory", "redis"})
    void leaseIsRenewedWhileTheHandlerRuns(String kind) throws Exception {
        Supplier<IdempotencyStore> store = stores(kind);
        AtomicInteger running = new AtomicInteger(), overlap = new AtomicInteger(), effects = new AtomicInteger();
        DispatchRuntime.Handler slow = (p, c) -> {
            overlap.accumulateAndGet(running.incrementAndGet(), Math::max);
            Thread.sleep(1300);
            running.decrementAndGet();
            effects.incrementAndGet();
        };
        Instance c = instance(store.get(), slow, Duration.ofMillis(300));
        Instance d = instance(store.get(), slow, Duration.ofMillis(300));
        byte[] body = event("evt-" + UUID.randomUUID());
        ExecutorService pool = Executors.newFixedThreadPool(2);
        java.util.concurrent.Future<?> first = pool.submit(() -> {
            c.tx().deliver(body);
            return null;
        });
        Thread.sleep(500); // well past one un-renewed lease
        java.util.concurrent.Future<?> second = pool.submit(() -> {
            d.tx().deliver(body);
            return null;
        });
        first.get(30, TimeUnit.SECONDS);
        second.get(30, TimeUnit.SECONDS);
        pool.shutdown();
        assertThat(effects.get()).isEqualTo(1);
        assertThat(overlap.get()).isEqualTo(1);
        assertThat(c.rt().leaseLost()).isZero();
        assertThat(d.tx().acks.get() + d.tx().nacks.get()).isEqualTo(1);
        c.rt().stop();
        d.rt().stop();
    }
}
