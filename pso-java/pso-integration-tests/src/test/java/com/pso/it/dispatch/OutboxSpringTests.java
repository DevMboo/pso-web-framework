package com.pso.it.dispatch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

/** The outbox wired by Spring Boot auto-configuration: real PostgreSQL for the data, real Redis Streams for delivery. */
class OutboxSpringTests {

    static List<String> base(String service, String... extra) {
        List<String> p = new ArrayList<>(List.of("server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "pso.service.name=" + service, "pso.dispatch.enabled=true", "pso.security.enabled=false",
            "pso.limits.requests.enabled=false", "pso.dispatch.retry.initial-delay=20ms", "pso.dispatch.retry.max-delay=50ms", "pso.dispatch.outbox.enabled=true","pso.dispatch.outbox.poll-interval=50ms"));
        p.addAll(List.of(extra));
        return p;
    }

    /** A bean of the application that needs the outbox, like the tutorial's OrderService. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    public static class NeedsOutbox {
        @org.springframework.context.annotation.Bean
        String outboxUser(Outbox outbox) {
            return "uses " + outbox.getClass().getSimpleName();
        }
    }

    /**
     * OUT-01: with dispatch disabled (the generated default) a service whose code injects Outbox still starts: no broker adapter, no
     * relay, nothing connects; storing an event fails loudly so the caller's transaction rolls back. No broker and no database needed.
     */
    @Test
    void aServiceThatInjectsTheOutboxStartsWhileDispatchIsDisabledAndRefusesToStoreEvents() {
        String[] off = {"server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "pso.service.name=it-outbox-off-service", "pso.security.enabled=false", "pso.limits.requests.enabled=false"};
        for (String[] props : new String[][] {off, java.util.stream.Stream.concat(java.util.Arrays.stream(off), java.util.stream.Stream.of("pso.dispatch.enabled=false", "pso.dispatch.outbox.enabled=true")).toArray(String[]::new)}) {
            try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(DispatchApp.class, NeedsOutbox.class).properties(props).run()) {
                Outbox outbox = ctx.getBean(Outbox.class);
                assertThat(ctx.getBean("outboxUser", String.class)).isEqualTo("uses Outbox");
                assertThat(outbox.isEnabled()).isFalse();
                assertThat(outbox.isRunning()).as("no relay thread").isFalse();
                assertThat(ctx.getBeanNamesForType(com.pso.dispatch.DispatchAdapter.class)).as("no broker adapter exists, so nothing can connect").isEmpty();
                assertThat(ctx.getBean(com.pso.dispatch.PsoDispatch.class)).isInstanceOf(com.pso.dispatch.PsoDispatch.Disabled.class);
                assertThatThrownBy(() -> outbox.publish("it.user-created", Map.of("run", "x", "n", 1, "mode", "ok")))
                    .isInstanceOf(com.pso.dispatch.DispatchException.class).hasMessageContaining("dispatch is disabled").hasMessageContaining("pso.dispatch.enabled=true");
                assertThat(outbox.relayOnce()).isZero();
                assertThat(outbox.cleanup()).isZero();
            }
        }
    }

    /** With dispatch ENABLED there is no placeholder: needing the outbox while it is switched off is a start-up error, as before. */
    @Test
    void withDispatchEnabledAndTheOutboxOffAServiceThatNeedsItDoesNotStart() {
        DispatchTests.requireBroker("redis");
        String[] p = {"server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF", "pso.service.name=" + DispatchTests.service(), "pso.security.enabled=false", "pso.limits.requests.enabled=false",
            "pso.dispatch.enabled=true", "pso.dispatch.provider=redis", "pso.dispatch.redis.url=" + System.getenv("PSO_TEST_REDIS_URL")};
        assertThatThrownBy(() -> new SpringApplicationBuilder(DispatchApp.class, NeedsOutbox.class).properties(p).run().close())
            .hasStackTraceContaining("Outbox");
        // the same service without the bean that needs the outbox starts: an application that does not use the outbox is not forced to have one
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(DispatchApp.class).properties(p).run()) {
            assertThat(ctx.getBeanNamesForType(Outbox.class)).isEmpty();
        }
    }

    @Test
    void enablingTheOutboxWithoutADatabaseStopsStartupWithTheFixToRun() {
        DispatchTests.requireBroker("redis");
        List<String> p = base(DispatchTests.service(), "pso.dispatch.provider=redis", "pso.dispatch.redis.url=" + System.getenv("PSO_TEST_REDIS_URL"),
            "spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration,org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration");
        assertThatThrownBy(() -> new SpringApplicationBuilder(DispatchApp.class).properties(p.toArray(new String[0])).run().close())
            .hasStackTraceContaining("pso.dispatch.outbox.enabled=true needs a JDBC database")
            .hasStackTraceContaining("pso dispatch:outbox");
    }

    @Test
    void anEventStoredInATransactionIsRelayedToRealRedisAndHandledByTheConsumer() throws Exception {
        DispatchTests.requireBroker("redis");
        String pg = System.getenv("PSO_TEST_POSTGRES_URL");
        assumeTrue(pg != null, "no real PostgreSQL available (run: node scripts/dispatch-brokers.mjs up)");
        // jdbc:postgresql://host:port/db?user=..&password=..
        String url = pg.substring(0, pg.indexOf('?'));
        Map<String, String> q = new java.util.HashMap<>();
        for (String kv : pg.substring(pg.indexOf('?') + 1).split("&")) {
            q.put(kv.substring(0, kv.indexOf('=')), kv.substring(kv.indexOf('=') + 1));
        }
        String service = DispatchTests.service();
        List<String> p = base(service, "pso.dispatch.provider=redis", "pso.dispatch.redis.url=" + System.getenv("PSO_TEST_REDIS_URL"), "pso.database.provider=postgresql", "spring.flyway.enabled=false","spring.datasource.url=" + url,
            "spring.datasource.username=" + q.get("user"), "spring.datasource.password=" + q.get("password"));
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(DispatchApp.class).properties(p.toArray(new String[0])).run()) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            for (String stmt : Outbox.TABLE_SQL.split(";\\s*\\n")) {
                if (!stmt.isBlank()) {
                    jdbc.execute(stmt);
                }
            }
            Outbox outbox = ctx.getBean(Outbox.class);
            TransactionTemplate tx = new TransactionTemplate(ctx.getBean(org.springframework.transaction.PlatformTransactionManager.class));
            String run = UUID.randomUUID().toString();
            tx.executeWithoutResult(s -> outbox.publish("it.user-created", Map.of("run", run, "n", 1, "mode", "ok")));
            try {
                tx.executeWithoutResult(s -> {
                    outbox.publish("it.user-created", Map.of("run", run, "n", 2, "mode", "ok"));
                    throw new IllegalStateException("rolled back");
                });
            } catch (IllegalStateException expected) {
                // the second event must never be delivered
            }
            DispatchApp.Handlers h = ctx.getBean(DispatchApp.Handlers.class);
            DispatchTests.until(() -> h.seen.stream().anyMatch(x -> x.startsWith(run + ":1")), 20_000);
            Thread.sleep(500);
            assertThat(h.seen.stream().filter(x -> x.startsWith(run + ":")).toList()).containsExactly(run + ":1:attempt1");
            assertThat(outbox.relayed()).isGreaterThanOrEqualTo(1);
        }
    }
}
