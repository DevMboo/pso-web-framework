package com.pso.orders.application;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * The tutorial's flow against real PostgreSQL (embedded, real Flyway migrations) and real Redis Streams (PSO_TEST_REDIS_URL):
 * commit, rollback, and the same event delivered twice. What each step observed is written to target/outbox-transcript.txt.
 *
 * Dispatch is switched on for THIS test class only. The service's profiles keep the generated default (dispatch disabled), so the
 * generated tests of the service (ApplicationTests, DatabaseMigrationTests) still describe it correctly: with dispatch disabled the
 * injected Outbox is a placeholder that refuses to store events, and the application starts.
 */
@SpringBootTest(properties = {
    "pso.dispatch.enabled=true",
    "pso.dispatch.redis.url=${PSO_TEST_REDIS_URL:redis://127.0.0.1:6379}",
    "pso.dispatch.outbox.poll-interval=100ms",
    "pso.dispatch.retry.initial-delay=50ms"
})
@ActiveProfiles("test")
class OrderOutboxTests {

    private static final StringBuilder TRANSCRIPT = new StringBuilder();

    @Autowired OrderService orders;
    @Autowired JdbcTemplate jdbc;
    @Autowired Outbox outbox;

    @AfterAll
    static void write() throws Exception {
        Path out = Path.of("target", "outbox-transcript.txt");
        Files.createDirectories(out.getParent());
        Files.writeString(out, TRANSCRIPT.toString());
    }

    private static void until(BooleanSupplier condition, long millis) throws InterruptedException {
        long end = System.currentTimeMillis() + millis;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < end) {
            Thread.sleep(50);
        }
        assertTrue(condition.getAsBoolean(), "condition not reached in " + millis + " ms");
    }

    private int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    @Test
    void aCommittedOrderIsRelayedConsumedAndAcknowledgedOnce() throws Exception {
        String id = "o-" + UUID.randomUUID();
        orders.create(id, 4999);
        // right after the commit the order and its outbox row exist together; the relay publishes afterwards
        assertEquals(1, count("select count(*) from orders where id = ?", id));
        until(() -> count("select count(*) from shipments where order_id = ?", id) == 1, 20_000);
        until(() -> count("select count(*) from pso_outbox where envelope like ? and published_at is not null", "%" + id + "%") == 1, 20_000);
        String row = jdbc.queryForObject("select id || ' attempts=' || attempts || ' published=' || (published_at is not null) || ' failed=' || (failed_at is not null) from pso_outbox where envelope like ?", String.class, "%" + id + "%");
        TRANSCRIPT.append("### commit\norder ").append(id).append(" stored; shipment created by the consumer\noutbox row: ").append(row).append("\n\n");
        assertEquals(1, count("select count(*) from shipments where order_id = ?", id));
    }

    @Test
    void aRolledBackTransactionLeavesNeitherTheOrderNorTheEvent() {
        String id = "o-" + UUID.randomUUID();
        int outboxBefore = count("select count(*) from pso_outbox");
        assertThrows(IllegalStateException.class, () -> orders.createThenFail(id, 100));
        assertEquals(0, count("select count(*) from orders where id = ?", id));
        assertEquals(outboxBefore, count("select count(*) from pso_outbox"), "the outbox row rolled back with the order");
        TRANSCRIPT.append("### rollback\norder ").append(id).append(": 0 rows in orders; pso_outbox unchanged (").append(outboxBefore).append(" rows)\n\n");
    }

    @Test
    void theSameEventDeliveredTwiceIsHandledOnce() throws Exception {
        String id = "o-" + UUID.randomUUID();
        orders.create(id, 1500);
        until(() -> count("select count(*) from shipments where order_id = ?", id) == 1, 20_000);
        until(() -> count("select count(*) from pso_outbox where envelope like ? and published_at is not null", "%" + id + "%") == 1, 20_000);
        long relayedBefore = outbox.relayed();
        // simulate a crash between the broker's acknowledgement and the row update: the row looks unpublished again
        jdbc.update("update pso_outbox set published_at = null, next_attempt_at = now() where envelope like ?", "%" + id + "%");
        until(() -> outbox.relayed() > relayedBefore, 20_000);
        until(() -> count("select count(*) from pso_outbox where envelope like ? and published_at is not null", "%" + id + "%") == 1, 20_000);
        Thread.sleep(500); // give the second delivery time to be handled
        assertEquals(1, count("select count(*) from shipments where order_id = ?", id), "the handler is idempotent: still one shipment");
        TRANSCRIPT.append("### duplicate delivery\nthe published row of order ").append(id).append(" was marked unpublished and relayed again (same event id)\nshipments for the order: 1\n\n");
    }
}
