package com.pso.dispatch;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchAdapter.Delivery;
import com.pso.dispatch.DispatchAdapter.Health;
import com.pso.dispatch.DispatchAdapter.PublishOptions;
import com.pso.dispatch.DispatchAdapter.PublishResult;
import com.pso.dispatch.DispatchAdapter.Subscription;
import com.pso.dispatch.DispatchAdapter.SubscriptionHandle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The delivery runtime: contract validation on publish; on consume parsing, version and schema checks, idempotency, in-process retry
 * with backoff, dead-lettering to {@code <channel>.dlq} and acknowledgement only AFTER the handler succeeded. Identical in behavior to
 * the TypeScript runtime. Retries are in-process (no scheduled redelivery): the message stays unacknowledged while it is retried.
 */
public final class DispatchRuntime implements PsoDispatch {

    private static final Logger LOG = LoggerFactory.getLogger(DispatchRuntime.class);

    public record Settings(String source, int concurrency, int batchSize, boolean retryEnabled, int maxAttempts, long initialDelayMillis, long maxDelayMillis,
                           double multiplier, boolean deadLetterEnabled, int maxMessageBytes, long idempotencyTtlMillis, long shutdownTimeoutMillis) {
        public Settings(String source) {
            this(source, 1, 10, true, 3, 1000, 30_000, 2.0, true, Envelope.MAX_BYTES, 24L * 3600_000, 10_000);
        }
    }

    @FunctionalInterface
    public interface Handler {
        void handle(JsonNode payload, ConsumeContext context) throws Exception;
    }

    private record Reg(String type, String group, int concurrency, Handler handler) {
    }

    private final Settings settings;
    private final DispatchAdapter adapter;
    private final Events.Registry registry;
    private final IdempotencyStore idem;
    private final ObjectMapper mapper;
    private final List<Reg> handlers = new ArrayList<>();
    private final List<SubscriptionHandle> handles = new ArrayList<>();
    private final AtomicLong published = new AtomicLong(), publishFailed = new AtomicLong(), consumed = new AtomicLong(), failed = new AtomicLong(), retried = new AtomicLong(),
        deadLettered = new AtomicLong(), dropped = new AtomicLong(), duplicates = new AtomicLong(), poison = new AtomicLong(), pCount = new AtomicLong(), pTotal = new AtomicLong(), pMax = new AtomicLong();
    private final AtomicLong untrusted = new AtomicLong(), unverified = new AtomicLong();
    private final AtomicLong contended = new AtomicLong(), leaseLost = new AtomicLong();
    /** how long a claim on an event id lives without being renewed; renewed while the handler runs (see {@link #idempotencyLease}) */
    private volatile long leaseMillis = 30_000;
    private final java.util.concurrent.ScheduledExecutorService renewals = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "pso-dispatch-lease");
        t.setDaemon(true);
        return t;
    });
    private final Trust trust;
    private volatile String state = "new";

    public DispatchRuntime(Settings settings, DispatchAdapter adapter, Events.Registry registry, IdempotencyStore idem, ObjectMapper mapper) {
        this(settings, adapter, registry, idem, mapper, Trust.OFF);
    }

    /** @param trust publisher authentication (see {@link Trust}); {@link Trust#OFF} is exactly the behaviour of the constructor above */
    public DispatchRuntime(Settings settings, DispatchAdapter adapter, Events.Registry registry, IdempotencyStore idem, ObjectMapper mapper, Trust trust) {
        this.trust = (trust == null ? Trust.OFF : trust).withOwnSource(settings.source());
        this.settings = settings;
        this.adapter = adapter;
        this.registry = registry;
        this.idem = idem != null ? idem : new IdempotencyStore.Memory();
        this.mapper = mapper;
    }

    public Settings settings() {
        return settings;
    }

    public DispatchAdapter adapter() {
        return adapter;
    }

    public Events.Registry registry() {
        return registry;
    }

    public Trust trust() {
        return trust;
    }

    /** Messages refused because their publisher could not be authenticated (dead-lettered, never handled). */
    public long untrusted() {
        return untrusted.get();
    }

    /** Messages handled without an authenticated publisher (permissive mode): must stay at zero before switching to required. */
    public long unverified() {
        return unverified.get();
    }

    /** Deliveries given back to the broker because another consumer was still processing the same event id. */
    public long contended() {
        return contended.get();
    }

    /** Handlers that finished after their claim had expired and been taken by another consumer (the handler may have run twice). */
    public long leaseLost() {
        return leaseLost.get();
    }

    /**
     * Sets how long a claim of a consumer that died blocks the others (default 30 s). It is not a limit on handler duration: the
     * runtime renews the claim while the handler runs.
     */
    public DispatchRuntime idempotencyLease(java.time.Duration lease) {
        if (lease == null || lease.toMillis() < 50 || lease.toMillis() > 3_600_000) {
            throw new DispatchException("PSO_DISPATCH_LEASE", "the idempotency lease must be between 50 ms and 1 h");
        }
        this.leaseMillis = lease.toMillis();
        return this;
    }

    /**
     * The transport headers of a message this service publishes on {@code channel} with exactly these bytes: its signature when a
     * signing key is configured, nothing otherwise. Used by publish() and by the transactional outbox relay.
     */
    public Map<String, String> signatureHeaders(String channel, byte[] body) {
        return trust.headersFor(channel, body);
    }

    /** Registers a consumer for a declared event. Must happen before start(). */
    public void register(String type, String group, int concurrency, Handler handler) {
        if (!state.equals("new")) {
            throw new DispatchException("PSO_DISPATCH_STATE", "consumers must be registered before start()");
        }
        if (registry.get(type) == null) {
            throw new DispatchException("PSO_DISPATCH_CONSUMER", "\"" + type + "\" is not a declared event (dispatch/*.events.json)");
        }
        handlers.add(new Reg(type, group == null || group.isBlank() ? settings.source() : group, concurrency > 0 ? concurrency : settings.concurrency(), handler));
    }

    public synchronized void start() {
        if (!state.equals("new")) {
            return;
        }
        adapter.connect();
        Map<String, List<Reg>> groups = new LinkedHashMap<>();
        for (Reg h : handlers) {
            groups.computeIfAbsent(registry.get(h.type()).channel() + "\u0000" + h.group(), k -> new ArrayList<>()).add(h);
        }
        for (Map.Entry<String, List<Reg>> g : groups.entrySet()) {
            String[] parts = g.getKey().split("\u0000");
            int conc = g.getValue().stream().mapToInt(Reg::concurrency).max().orElse(1);
            handles.add(adapter.subscribe(new Subscription(parts[0], parts[1], conc, settings.batchSize(), d -> process(d, parts[1], g.getValue()))));
        }
        state = "started";
    }

    public synchronized void stop() {
        if (state.equals("stopped")) {
            return;
        }
        state = "stopped";
        for (SubscriptionHandle h : handles) {
            h.stop(settings.shutdownTimeoutMillis());
        }
        adapter.close();
    }

    /** A validated, ready-to-send event: contract checks done, envelope built. Used by publish() and by the transactional outbox. */
    public record Prepared(Envelope envelope, String channel, String key) {
    }

    /** Applies every publish-time rule (declared, publishable, schema, size) without sending anything. */
    public Prepared prepare(String type, Object payload, PublishInput in) {
        Events.Decl decl = registry.get(type);
        if (decl == null) {
            throw new DispatchException("PSO_DISPATCH_UNKNOWN_EVENT", "event \"" + type + "\" is not declared (dispatch/*.events.json): declare it before publishing");
        }
        if (!decl.publish()) {
            throw new DispatchException("PSO_DISPATCH_NOT_PUBLISHER", "event \"" + type + "\" is declared as consume-only in this service");
        }
        JsonNode tree = payload instanceof JsonNode n ? n : mapper.valueToTree(payload);
        if (decl.schema() != null) {
            List<String> bad = Schemas.validate(decl.schema(), tree, "$");
            if (!bad.isEmpty()) {
                throw new DispatchException("PSO_DISPATCH_SCHEMA", "payload of \"" + type + "\" violates its schema: " + String.join("; ", bad.subList(0, Math.min(5, bad.size()))));
            }
        }
        String key = in.key();
        if (key == null && decl.key() != null) {
            JsonNode cur = tree;
            for (String part : decl.key().split("\\.")) {
                cur = cur == null ? null : cur.get(part);
            }
            key = cur == null || cur.isNull() ? null : cur.asText();
        }
        Envelope env = Envelope.create(type, decl.version(), settings.source(), tree, in.correlationId(), in.causationId(), null, in.id());
        if (env.bytes().length > settings.maxMessageBytes()) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_TOO_LARGE", "event \"" + type + "\" exceeds " + settings.maxMessageBytes() + " bytes");
        }
        return new Prepared(env, decl.channel(), key);
    }

    @Override
    public PublishResult publish(String type, Object payload, PublishInput in) {
        Prepared p = prepare(type, payload, in);
        try {
            PublishResult r = adapter.publish(p.channel(), p.envelope(), new PublishOptions(p.key(), in.timeoutMillis(), signatureHeaders(p.channel(), p.envelope().bytes())));
            published.incrementAndGet();
            return r;
        } catch (DispatchException e) {
            publishFailed.incrementAndGet();
            throw e;
        } catch (RuntimeException e) {
            publishFailed.incrementAndGet();
            throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publishing \"" + type + "\" failed (" + e.getClass().getSimpleName() + ")", e);
        }
    }

    private void process(Delivery d, String group, List<Reg> hs) {
        Envelope env;
        try {
            env = Envelope.parse(d.body(), settings.maxMessageBytes());
        } catch (DispatchException e) {
            poison.incrementAndGet();
            deadLetter(d, group, 0, e.code());
            return;
        }
        List<Reg> mine = new ArrayList<>();
        for (Reg h : hs) {
            if (h.type().equals(env.type())) {
                mine.add(h);
            }
        }
        if (mine.isEmpty()) {
            d.ack(); // another consumer of the same channel handles this type
            return;
        }
        Events.Decl decl = registry.get(env.type());
        if (env.version() != decl.version() && !decl.accepts().contains(env.version())) {
            poison.incrementAndGet();
            deadLetter(d, group, 0, "PSO_DISPATCH_UNSUPPORTED_VERSION");
            return;
        }
        if (env.version() == decl.version() && decl.schema() != null && !Schemas.validate(decl.schema(), env.payload(), "$").isEmpty()) {
            poison.incrementAndGet();
            deadLetter(d, group, 0, "PSO_DISPATCH_SCHEMA");
            return;
        }
        // who published this? env.source() is only a claim; with trust enabled it must be backed by a signature of that service's key
        String verifiedSource = null;
        if (trust.mode() != Trust.Mode.OFF) {
            Trust.Verdict verdict = trust.verify(d.channel(), d.body(), d.headers() == null ? null : d.headers().get(Trust.HEADER), env.source());
            if (verdict == Trust.Verdict.VERIFIED) {
                verifiedSource = env.source();
            } else if (trust.mode() == Trust.Mode.REQUIRED || verdict == Trust.Verdict.INVALID) {
                untrusted.incrementAndGet();
                poison.incrementAndGet();
                LOG.warn("message refused: the publisher is not authenticated: event={} id={} claimedSource={} reason={} channel={}", env.type(), env.id(), env.source(), verdict.wire(), d.channel());
                deadLetter(d, group, 0, "PSO_DISPATCH_UNTRUSTED:" + verdict.wire()); // never handled, never retried: retrying cannot make it authentic
                return;
            } else {
                unverified.incrementAndGet();
            }
        }
        String key = group + ":" + env.id();
        // one consumer at a time per (group, event id): the id is claimed atomically BEFORE the handler runs. A store failure is not
        // "unseen": the message is not handled and goes back to the broker
        String owner = UUID.randomUUID().toString();
        IdempotencyStore.Claim claim;
        try {
            claim = acquire(key, owner);
        } catch (RuntimeException e) {
            LOG.error("idempotency store unavailable; the message is not handled and stays with the broker: event={} id={} error={}", env.type(), env.id(), e.getClass().getSimpleName());
            try {
                Thread.sleep(250); // no hot redelivery loop while the store is down
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
            d.nack();
            return;
        }
        if (claim == IdempotencyStore.Claim.DONE) {
            duplicates.incrementAndGet();
            d.ack();
            return;
        }
        if (claim == IdempotencyStore.Claim.BUSY) {
            contended.incrementAndGet();
            d.nack(); // the other consumer is still running: redelivered later, then a duplicate or claimable
            return;
        }
        java.util.concurrent.atomic.AtomicBoolean lost = new java.util.concurrent.atomic.AtomicBoolean();
        long lease = leaseMillis;
        java.util.concurrent.ScheduledFuture<?> renewal = renewals.scheduleAtFixedRate(() -> {
            try {
                if (!idem.renew(key, owner, lease) && lost.compareAndSet(false, true)) {
                    LOG.warn("the claim on an event id expired while its handler was still running; another consumer may run it too: key={}", key);
                }
            } catch (RuntimeException e) {
                // the store is unreachable: the next renewal tries again; if the lease runs out, complete() reports it
            }
        }, Math.max(5, lease / 3), Math.max(5, lease / 3), java.util.concurrent.TimeUnit.MILLISECONDS);
        try {
            int max = settings.retryEnabled() ? settings.maxAttempts() : 1;
            int attempt = 0;
            long delay = settings.initialDelayMillis();
            String last = "error";
            long started = System.currentTimeMillis();
            while (attempt < max && !state.equals("stopped")) {
                attempt++;
                boolean ok = false;
                try {
                    for (Reg h : mine) {
                        h.handler().handle(env.payload(), new ConsumeContext(env, attempt, group, verifiedSource));
                    }
                    ok = true;
                } catch (Exception e) {
                    last = e.getClass().getSimpleName();
                    failed.incrementAndGet();
                    LOG.warn("consumer failed: event={} id={} attempt={} error={}", env.type(), env.id(), attempt, last);
                    if (attempt < max) {
                        retried.incrementAndGet();
                        try {
                            Thread.sleep(delay);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            giveBack(key, owner);
                            d.nack();
                            return;
                        }
                        delay = Math.min(settings.maxDelayMillis(), Math.round(delay * settings.multiplier()));
                    }
                }
                if (ok) {
                    long ms = System.currentTimeMillis() - started;
                    consumed.incrementAndGet();
                    pCount.incrementAndGet();
                    pTotal.addAndGet(ms);
                    pMax.accumulateAndGet(ms, Math::max);
                    renewal.cancel(false);
                    finish(key, owner, lost.get(), env);
                    d.ack(); // acknowledged only AFTER the handler succeeded
                    return;
                }
            }
            giveBack(key, owner); // not processed: the id must be claimable again (by a redelivery or a replayed dead letter)
            if (state.equals("stopped") && attempt < max) {
                d.nack(); // shutting down mid-retry: let the transport redeliver
                return;
            }
            deadLetter(d, group, attempt, "handler-failed:" + last);
        } finally {
            renewal.cancel(false);
        }
    }

    /**
     * Claims the event id. While another consumer holds a live lease this waits (bounded by one lease period, because a holder that
     * died stops renewing) and then answers BUSY.
     */
    private IdempotencyStore.Claim acquire(String key, String owner) {
        long lease = leaseMillis;
        long deadline = System.currentTimeMillis() + lease + 1000;
        while (true) {
            IdempotencyStore.Claim c = idem.claim(key, owner, lease);
            if (c != IdempotencyStore.Claim.BUSY || state.equals("stopped") || System.currentTimeMillis() >= deadline) {
                return c;
            }
            try {
                Thread.sleep(Math.min(200, Math.max(10, lease / 10)));
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return IdempotencyStore.Claim.BUSY;
            }
        }
    }

    /** Turns the claim into a completion record. The handler already ran: a record that cannot be written is reported, never hidden. */
    private void finish(String key, String owner, boolean lost, Envelope env) {
        for (int i = 0; ; i++) {
            try {
                if (!idem.complete(key, owner, settings.idempotencyTtlMillis()) || lost) {
                    leaseLost.incrementAndGet();
                    LOG.warn("an event was handled after its claim had expired: another consumer may have handled it as well (raise the idempotency lease or make the handler idempotent): event={} id={}", env.type(), env.id());
                }
                return;
            } catch (RuntimeException e) {
                if (i >= 2) {
                    LOG.error("the event was handled but its completion could not be recorded: a later redelivery will run the handler again: event={} id={} error={}", env.type(), env.id(), e.getClass().getSimpleName());
                    return;
                }
                try {
                    Thread.sleep(100L * (i + 1));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private void giveBack(String key, String owner) {
        try {
            idem.release(key, owner);
        } catch (RuntimeException e) {
            // the lease expires on its own
        }
    }

    /** Writes the message to {@code <channel>.dlq} and only then acknowledges it. If that fails the message stays unacknowledged. */
    private void deadLetter(Delivery d, String group, int attempts, String reason) {
        if (!settings.deadLetterEnabled()) {
            dropped.incrementAndGet();
            LOG.error("message dropped (dead-letter disabled): channel={} reason={}", d.channel(), reason);
            d.ack();
            return;
        }
        try {
            adapter.publishRaw(d.channel() + ".dlq", d.body(), new PublishOptions(null, 0, Map.of(
                "x-pso-reason", reason.length() > 200 ? reason.substring(0, 200) : reason, "x-pso-attempts", String.valueOf(attempts), "x-pso-group", group,
                "x-pso-original-channel", d.channel(), "x-pso-dead-letter-id", UUID.randomUUID().toString())));
        } catch (RuntimeException e) {
            LOG.error("dead-letter publish failed; the message stays unacknowledged: channel={} error={}", d.channel(), e.getClass().getSimpleName());
            d.nack();
            return;
        }
        deadLettered.incrementAndGet();
        d.ack();
    }

    @Override
    public Health health() {
        return adapter.health();
    }

    @Override
    public Metrics metrics() {
        return new Metrics(published.get(), publishFailed.get(), consumed.get(), failed.get(), retried.get(), deadLettered.get(), dropped.get(), duplicates.get(), poison.get(), pCount.get(), pTotal.get(), pMax.get());
    }
}
