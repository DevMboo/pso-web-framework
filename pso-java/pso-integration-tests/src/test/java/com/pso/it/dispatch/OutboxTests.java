package com.pso.it.dispatch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.Events;
import com.pso.dispatch.PsoDispatch.PublishInput;
import com.pso.dispatch.test.MemoryAdapter;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/** The transactional outbox against a REAL PostgreSQL (scripts/dispatch-brokers.mjs). Skipped, and reported as unverified, without it. */
class OutboxTests {

    JdbcTemplate jdbc;
    TransactionTemplate tx;
    MemoryAdapter adapter;
    DispatchRuntime runtime;
    Outbox outbox;

    @BeforeEach
    void setUp() throws Exception {
        String url = System.getenv("PSO_TEST_POSTGRES_URL");
        assumeTrue(url != null, "no real PostgreSQL available (run: node scripts/dispatch-brokers.mjs up)");
        DataSource ds = new DriverManagerDataSource(url);
        jdbc = new JdbcTemplate(ds);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        jdbc.execute("DROP TABLE IF EXISTS pso_outbox");
        jdbc.execute("DROP TABLE IF EXISTS orders_test");
        for (String stmt : Outbox.TABLE_SQL.split(";\\s*\\n")) {
            if (!stmt.isBlank()) {
                jdbc.execute(stmt);
            }
        }
        jdbc.execute("CREATE TABLE orders_test (id VARCHAR(64) PRIMARY KEY)");
        Events.Registry reg = new Events.Registry();
        reg.add(new Events.Decl("orders.created", 1, "orders.events", new ObjectMapper().readTree("{\"type\":\"object\",\"required\":[\"orderId\"],\"properties\":{\"orderId\":{\"type\":\"string\"}}}"), "full", null, true, "orderId"));
        adapter = new MemoryAdapter();
        adapter.connect();
        runtime = new DispatchRuntime(new DispatchRuntime.Settings("orders-service"), adapter, reg, null, new ObjectMapper());
        outbox = new Outbox(runtime, jdbc, tx, new Outbox.Config(10, 3, Duration.ofMillis(50), Duration.ofMillis(10), Duration.ofDays(7)));
    }

    @AfterEach
    void tearDown() {
        if (outbox != null) {
            outbox.stop();
        }
    }

    int count(String where) {
        return jdbc.queryForObject("SELECT count(*) FROM pso_outbox WHERE " + where, Integer.class);
    }

    @Test
    void theEventCommitsOrRollsBackTogetherWithTheBusinessData() {
        String ok = UUID.randomUUID().toString(), lost = UUID.randomUUID().toString();
        tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO orders_test (id) VALUES (?)", ok);
            outbox.publish("orders.created", Map.of("orderId", ok));
        });
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO orders_test (id) VALUES (?)", lost);
            outbox.publish("orders.created", Map.of("orderId", lost));
            throw new IllegalStateException("business failure after the outbox insert");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM orders_test WHERE id = ?", Integer.class, lost)).isZero();
        assertThat(count("envelope LIKE '%" + lost + "%'")).as("a rolled-back transaction leaves no event behind").isZero();
        assertThat(count("envelope LIKE '%" + ok + "%'")).isEqualTo(1);
        assertThat(adapter.messages("orders.events")).as("nothing reaches the broker before the relay runs").isEmpty();
    }

    @Test
    void theContractIsEnforcedAtEnqueueTime() {
        assertThatThrownBy(() -> outbox.publish("orders.created", Map.of("orderId", 5))).isInstanceOfSatisfying(DispatchException.class, e -> assertThat(e.code()).isEqualTo("PSO_DISPATCH_SCHEMA"));
        assertThatThrownBy(() -> outbox.publish("orders.unknown", Map.of())).isInstanceOfSatisfying(DispatchException.class, e -> assertThat(e.code()).isEqualTo("PSO_DISPATCH_UNKNOWN_EVENT"));
        assertThat(count("true")).isZero();
    }

    @Test
    void theRelayPublishesAndMarksTheRowOnlyAfterTheBrokerAcknowledged() {
        outbox.publish("orders.created", Map.of("orderId", "o-1"), new PublishInput("corr-1", null, null, "evt-o-1", 0));
        assertThat(outbox.relayOnce()).isEqualTo(1);
        List<MemoryAdapter.Message> sent = adapter.messages("orders.events");
        assertThat(sent).hasSize(1);
        Envelope e = Envelope.parse(sent.get(0).body());
        assertThat(List.of(e.id(), e.correlationId(), e.source())).containsExactly("evt-o-1", "corr-1", "orders-service");
        assertThat(count("published_at IS NOT NULL")).isEqualTo(1);
        assertThat(outbox.relayOnce()).as("published rows are not sent again").isZero();
    }

    @Test
    void aBrokerOutageKeepsTheRowAndTheRelayRetriesUntilItRecovers() throws Exception {
        outbox.publish("orders.created", Map.of("orderId", "o-2"));
        adapter.failPublish.set(new IllegalStateException("broker down"));
        assertThat(outbox.relayOnce()).isZero();
        assertThat(count("published_at IS NULL AND failed_at IS NULL AND attempts = 1")).as("attempt recorded, nothing deleted").isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT last_error FROM pso_outbox", String.class)).isEqualTo("IllegalStateException");
        adapter.failPublish.set(null);
        Thread.sleep(40); // wait out the backoff
        assertThat(outbox.relayOnce()).isEqualTo(1);
        assertThat(count("published_at IS NOT NULL")).isEqualTo(1);
    }

    @Test
    void afterMaxAttemptsTheEventIsMarkedFailedNotDeleted() throws Exception {
        outbox.publish("orders.created", Map.of("orderId", "o-3"));
        adapter.failPublish.set(new IllegalStateException("broker down"));
        for (int i = 0; i < 6; i++) {
            outbox.relayOnce();
            Thread.sleep(90);
        }
        assertThat(count("failed_at IS NOT NULL AND published_at IS NULL AND attempts = 3")).isEqualTo(1);
        assertThat(outbox.gaveUp()).isEqualTo(1);
        adapter.failPublish.set(null);
        assertThat(outbox.relayOnce()).as("a failed event is not retried silently forever").isZero();
    }

    @Test
    void concurrentRelaysNeverSendTheSameRowTwice() throws Exception {
        for (int i = 0; i < 30; i++) {
            outbox.publish("orders.created", Map.of("orderId", "c-" + i));
        }
        Outbox other = new Outbox(runtime, jdbc, tx, new Outbox.Config(10, 3, Duration.ofMillis(50), Duration.ofMillis(10), Duration.ofDays(7)));
        AtomicInteger total = new AtomicInteger();
        Thread[] ts = new Thread[4];
        for (int i = 0; i < ts.length; i++) {
            Outbox o = i % 2 == 0 ? outbox : other;
            ts[i] = Thread.ofVirtual().start(() -> {
                int n;
                do {
                    n = o.relayOnce();
                    total.addAndGet(n);
                } while (n > 0);
            });
        }
        for (Thread t : ts) {
            t.join();
        }
        assertThat(total.get()).isEqualTo(30);
        assertThat(adapter.messages("orders.events")).hasSize(30);
        assertThat(adapter.messages("orders.events").stream().map(m -> Envelope.parse(m.body()).id()).distinct().count()).isEqualTo(30);
    }

    @Test
    void retentionDeletesOnlyOldPublishedRows() {
        outbox.publish("orders.created", Map.of("orderId", "old"));
        outbox.publish("orders.created", Map.of("orderId", "pending"));
        outbox.relayOnce();
        jdbc.update("UPDATE pso_outbox SET published_at = ? WHERE envelope LIKE '%old%'", java.sql.Timestamp.from(java.time.Instant.now().minus(Duration.ofDays(8))));
        jdbc.update("UPDATE pso_outbox SET published_at = NULL WHERE envelope LIKE '%pending%'");
        assertThat(outbox.cleanup()).isEqualTo(1);
        assertThat(count("true")).as("the pending row survives").isEqualTo(1);
    }

    @Test
    void theBackgroundRelayDeliversWithoutBeingCalled() throws Exception {
        outbox.start();
        outbox.publish("orders.created", Map.of("orderId", "bg"));
        long end = System.currentTimeMillis() + 10_000;
        while (adapter.messages("orders.events").isEmpty() && System.currentTimeMillis() < end) {
            Thread.sleep(50);
        }
        assertThat(adapter.messages("orders.events")).hasSize(1);
    }
}
