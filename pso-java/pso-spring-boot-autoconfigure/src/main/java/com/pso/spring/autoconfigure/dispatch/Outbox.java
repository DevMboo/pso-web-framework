package com.pso.spring.autoconfigure.dispatch;

import com.pso.dispatch.DispatchAdapter.PublishOptions;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.PsoDispatch.PublishInput;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The transactional outbox. {@link #publish} validates the event exactly like {@code PsoDispatch.publish} and then INSERTs a row through
 * the application's JdbcTemplate, so it commits or rolls back together with the business data of the same transaction. A relay
 * publishes pending rows to the broker afterwards and marks them published ONLY after the broker acknowledged them.
 *
 * <p>Guarantees: an event is never lost once its transaction committed; it may be published more than once (a crash between the
 * broker acknowledgement and the database update), always with the same event id, so consumers deduplicate on it. Publishing to a
 * broker and committing a database transaction are NOT atomic; this pattern is how the gap is closed without pretending otherwise.
 */
public final class Outbox implements SmartLifecycle {

    private static final Logger LOG = LoggerFactory.getLogger(Outbox.class);

    /** The migration PSO generates (`pso dispatch:outbox`); tests and tools can create the same table. */
    public static final String TABLE_SQL = """
        CREATE TABLE IF NOT EXISTS pso_outbox (
            id              VARCHAR(128) PRIMARY KEY,
            channel         VARCHAR(100)  NOT NULL,
            event_key       VARCHAR(256),
            envelope        TEXT          NOT NULL,
            created_at      TIMESTAMP     NOT NULL,
            attempts        INTEGER       NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMP     NOT NULL,
            last_error      VARCHAR(200),
            published_at    TIMESTAMP,
            failed_at       TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS pso_outbox_pending ON pso_outbox (next_attempt_at) WHERE published_at IS NULL AND failed_at IS NULL;
        """;

    public record Config(int batchSize, int maxAttempts, Duration pollInterval, Duration retryBackoff, Duration retention) {
    }

    private final DispatchRuntime runtime;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final Config cfg;
    private final AtomicLong relayed = new AtomicLong(), failures = new AtomicLong(), gaveUp = new AtomicLong();
    private volatile boolean running;
    private Thread loop;

    public Outbox(DispatchRuntime runtime, JdbcTemplate jdbc, TransactionTemplate tx, Config cfg) {
        this.runtime = runtime;
        this.jdbc = jdbc;
        this.tx = tx;
        this.cfg = cfg;
    }

    /**
     * What the application gets while dispatch is disabled ({@code pso.dispatch.enabled=false}, the default), like
     * {@link com.pso.dispatch.PsoDispatch.Disabled}: a service whose code injects {@code Outbox} still starts (its other features,
     * its migrations and its tests work), nothing connects and no relay runs. Storing an event fails with a clear error, so the
     * surrounding transaction rolls back: an event is never accepted and then silently not delivered.
     */
    public static Outbox disabled() {
        return new Outbox(null, null, null, null);
    }

    /** False for the placeholder of a service whose dispatch is disabled; true for a working outbox. */
    public boolean isEnabled() {
        return runtime != null;
    }

    /** Stores the event in the current transaction. Call it from the same transaction that changes your data. */
    public void publish(String type, Object payload, PublishInput input) {
        if (runtime == null) {
            throw new DispatchException("PSO_DISPATCH_DISABLED", "cannot store \"" + type + "\" in the outbox: dispatch is disabled (pso.dispatch.enabled=false). "
                + "Set pso.dispatch.enabled=true (and pso.dispatch.outbox.enabled=true) for this environment; the transaction was not completed");
        }
        DispatchRuntime.Prepared p = runtime.prepare(type, payload, input == null ? PublishInput.none() : input);
        Timestamp now = Timestamp.from(Instant.now());
        jdbc.update("INSERT INTO pso_outbox (id, channel, event_key, envelope, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
            p.envelope().id(), p.channel(), p.key(), p.envelope().serialize(), now, now);
    }

    public void publish(String type, Object payload) {
        publish(type, payload, PublishInput.none());
    }

    /** One relay pass; returns how many events were published. Safe to run on several instances at once (rows are locked, not shared). */
    public int relayOnce() {
        if (runtime == null) {
            return 0;
        }
        Integer n = tx.execute(status -> {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT id, channel, event_key, envelope, attempts FROM pso_outbox WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ? ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED",
                Timestamp.from(Instant.now()), cfg.batchSize());
            int done = 0;
            for (Map<String, Object> r : rows) {
                String id = (String) r.get("id");
                int attempts = ((Number) r.get("attempts")).intValue();
                try {
                    // signed at relay time over the exact bytes sent, like a direct publish (no signature without a signing key)
                    byte[] body = ((String) r.get("envelope")).getBytes(StandardCharsets.UTF_8);
                    runtime.adapter().publishRaw((String) r.get("channel"), body,
                        new PublishOptions((String) r.get("event_key"), 15_000, runtime.signatureHeaders((String) r.get("channel"), body)));
                    jdbc.update("UPDATE pso_outbox SET published_at = ?, last_error = NULL WHERE id = ?", Timestamp.from(Instant.now()), id);
                    relayed.incrementAndGet();
                    done++;
                } catch (RuntimeException e) {
                    failures.incrementAndGet();
                    int next = attempts + 1;
                    String why = e instanceof DispatchException de ? de.code() : e.getClass().getSimpleName();
                    if (next >= cfg.maxAttempts()) {
                        jdbc.update("UPDATE pso_outbox SET attempts = ?, last_error = ?, failed_at = ? WHERE id = ?", next, why, Timestamp.from(Instant.now()), id);
                        gaveUp.incrementAndGet();
                        LOG.error("outbox event {} gave up after {} attempts: {}", id, next, why);
                    } else {
                        long delay = Math.min(cfg.retryBackoff().toMillis() * (1L << Math.min(next - 1, 10)), Duration.ofMinutes(10).toMillis());
                        jdbc.update("UPDATE pso_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", next, why, Timestamp.from(Instant.now().plusMillis(delay)), id);
                    }
                }
            }
            return done;
        });
        return n == null ? 0 : n;
    }

    /** Deletes events that were published more than {@code retention} ago. Pending and failed rows are never deleted. */
    public int cleanup() {
        if (runtime == null) {
            return 0;
        }
        return jdbc.update("DELETE FROM pso_outbox WHERE published_at IS NOT NULL AND published_at < ?", Timestamp.from(Instant.now().minus(cfg.retention())));
    }

    public long relayed() { return relayed.get(); }
    public long failures() { return failures.get(); }
    public long gaveUp() { return gaveUp.get(); }

    @Override
    public synchronized void start() {
        if (running || runtime == null) {
            return; // the disabled placeholder never starts a relay
        }
        running = true;
        loop = Thread.ofVirtual().name("pso-outbox-relay").start(() -> {
            long lastCleanup = 0;
            while (running) {
                try {
                    int n = relayOnce();
                    if (System.currentTimeMillis() - lastCleanup > 60_000) {
                        lastCleanup = System.currentTimeMillis();
                        cleanup();
                    }
                    if (n == 0) {
                        Thread.sleep(cfg.pollInterval().toMillis());
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (RuntimeException e) {
                    LOG.warn("outbox relay pass failed: {}", e.getClass().getSimpleName());
                    try {
                        Thread.sleep(cfg.pollInterval().toMillis());
                    } catch (InterruptedException ie) {
                        return;
                    }
                }
            }
        });
    }

    @Override
    public synchronized void stop() {
        running = false;
        if (loop != null) {
            loop.interrupt();
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return Integer.MAX_VALUE - 50; // starts after the dispatch runtime has connected, stops before it
    }
}
