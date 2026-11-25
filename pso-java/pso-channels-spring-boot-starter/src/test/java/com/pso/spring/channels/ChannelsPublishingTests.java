package com.pso.spring.channels;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.Events;
import com.pso.dispatch.PsoDispatch;
import com.pso.dispatch.test.MemoryAdapter;
import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.io.File;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration;
import org.springframework.boot.autoconfigure.aop.AopAutoConfiguration;
import org.springframework.boot.autoconfigure.transaction.TransactionAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The publisher and the annotation with REAL Spring transactions (H2 + DataSourceTransactionManager), the REAL outbox class and the REAL
 * Dispatch runtime. The transport is Dispatch's in-memory adapter: it follows the adapter contract but is not a broker, so these tests
 * prove WHAT is handed to Dispatch and WHEN (commit, rollback, outbox), not Redis/RabbitMQ/Kafka behaviour.
 */
class ChannelsPublishingTests {

    static final ObjectMapper M = new ObjectMapper();

    record CandidateUpdated(String candidateId, String status) {
    }

    static class RecruitmentService {
        private final PsoChannelPublisher publisher;
        private final JdbcTemplate jdbc;

        RecruitmentService(PsoChannelPublisher publisher, JdbcTemplate jdbc) {
            this.publisher = publisher;
            this.jdbc = jdbc;
        }

        @Transactional
        @ChannelPublish(channel = "candidate.{candidateId}", event = "candidate.updated", delivery = PsoChannelPublisher.Delivery.DURABLE)
        public CandidateUpdated updateDurable(String id, String status, boolean fail) {
            jdbc.update("INSERT INTO candidate (id, status) VALUES (?, ?)", id, status);
            if (fail) {
                throw new IllegalStateException("business rule violated");
            }
            return new CandidateUpdated(id, status);
        }

        @Transactional
        @ChannelPublish(channel = "candidate.{candidateId}", event = "candidate.updated")
        public CandidateUpdated updateBestEffort(String id, String status, boolean fail) {
            jdbc.update("INSERT INTO candidate (id, status) VALUES (?, ?)", id, status);
            if (fail) {
                throw new IllegalStateException("business rule violated");
            }
            return new CandidateUpdated(id, status);
        }

        @ChannelPublish(channel = "recruitment", event = "recruitment.changed")
        public CandidateUpdated noTransaction() {
            return new CandidateUpdated("c9", "NEW");
        }

        @ChannelPublish(channel = "recruitment", event = "recruitment.changed")
        public CandidateUpdated nothingToReport() {
            return null;
        }

        @ChannelPublish(channel = "candidate.{candidateId}", event = "candidate.updated", delivery = PsoChannelPublisher.Delivery.DURABLE)
        public CandidateUpdated durableWithoutTransaction() {
            return new CandidateUpdated("c1", "X");
        }

        /** self-invocation bypasses the proxy: documented Spring AOP limitation, shown here so nobody is surprised */
        public CandidateUpdated callsAnotherMethodOfThisObject() {
            return noTransaction();
        }
    }

    static class Infra {
        final MemoryAdapter adapter = new MemoryAdapter();

        @Bean
        DispatchRuntime dispatch() throws Exception {
            Events.Registry reg = new Events.Registry();
            JsonNode schema = M.readTree("{\"type\":\"object\",\"required\":[\"v\",\"id\",\"type\",\"channel\",\"ts\",\"source\",\"payload\"],\"additionalProperties\":false,\"properties\":{\"v\":{\"type\":\"integer\"},\"id\":{\"type\":\"string\"},\"type\":{\"type\":\"string\"},\"channel\":{\"type\":\"string\"},\"ts\":{\"type\":\"string\"},\"correlationId\":{\"type\":\"string\"},\"source\":{\"type\":\"string\"},\"payload\":{\"type\":\"object\"}}}");
            reg.add(new Events.Decl("channels.publish", 1, "channels-events", schema, "full", null, true, null));
            DispatchRuntime rt = new DispatchRuntime(new DispatchRuntime.Settings("recruitment-service", 1, 10, true, 3, 1, 4, 2.0, true, Envelope.MAX_BYTES, 24L * 3600_000, 5000), adapter, reg, null, M);
            rt.start();
            return rt;
        }

        @Bean
        MemoryAdapter adapter() {
            return adapter;
        }

        @Bean
        Outbox outbox(DispatchRuntime rt, JdbcTemplate jdbc, PlatformTransactionManager tm) {
            jdbc.execute("CREATE TABLE IF NOT EXISTS pso_outbox (id VARCHAR(128) PRIMARY KEY, channel VARCHAR(100) NOT NULL, event_key VARCHAR(256), envelope TEXT NOT NULL, created_at TIMESTAMP NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP NOT NULL, last_error VARCHAR(200), published_at TIMESTAMP, failed_at TIMESTAMP)");
            jdbc.execute("CREATE TABLE IF NOT EXISTS candidate (id VARCHAR(64) PRIMARY KEY, status VARCHAR(32))");
            return new Outbox(rt, jdbc, new TransactionTemplate(tm), new Outbox.Config(10, 3, Duration.ofSeconds(1), Duration.ofMillis(10), Duration.ofHours(1)));
        }

        @Bean
        RecruitmentService recruitmentService(PsoChannelPublisher p, JdbcTemplate j) {
            return new RecruitmentService(p, j);
        }
    }

    private static int dbCounter;

    private ApplicationContextRunner runner(String... props) {
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PsoAutoConfiguration.class, DataSourceAutoConfiguration.class, DataSourceTransactionManagerAutoConfiguration.class, JdbcTemplateAutoConfiguration.class,
                TransactionAutoConfiguration.class, AopAutoConfiguration.class, PsoChannelsAutoConfiguration.class))
            .withUserConfiguration(Infra.class)
            .withPropertyValues("pso.service.name=recruitment-service", "pso.channels.enabled=true", "spring.datasource.url=jdbc:h2:mem:ch" + (++dbCounter) + ";DB_CLOSE_DELAY=-1", "spring.datasource.generate-unique-name=false")
            .withPropertyValues(props);
    }

    private static JsonNode envelopeOf(MemoryAdapter a, int i) throws Exception {
        Envelope e = Envelope.parse(a.messages("channels-events").get(i).body());
        assertThat(e.type()).isEqualTo("channels.publish");
        return M.readTree(e.serialize()).get("payload");
    }

    private static int count(JdbcTemplate j, String table) {
        return j.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class);
    }

    @Test
    void bestEffortWithoutATransactionIsSentImmediatelyAsAnEnvelopeTheOrchestratorCanValidate() throws Exception {
        runner().run(ctx -> {
            assertThat(ctx).hasNotFailed();
            MDC.put("correlationId", "corr-java-0001");
            try {
                PsoChannelPublisher.Outcome o = ctx.getBean(PsoChannelPublisher.class).publish("candidate.c1", "candidate.updated", new CandidateUpdated("c1", "HIRED"));
                assertThat(o.status()).isEqualTo(PsoChannelPublisher.Status.SENT);
                assertThat(o.delivery()).isEqualTo(PsoChannelPublisher.Delivery.BEST_EFFORT);
                assertThat(o.acknowledgement()).contains("not durable");
                JsonNode m = envelopeOf(ctx.getBean(MemoryAdapter.class), 0);
                assertThat(m.get("v").asInt()).isEqualTo(1);
                assertThat(m.get("id").asText()).isEqualTo(o.eventId());
                assertThat(m.get("type").asText()).isEqualTo("candidate.updated");
                assertThat(m.get("channel").asText()).isEqualTo("candidate.c1");
                assertThat(m.get("source").asText()).isEqualTo("recruitment-service");
                assertThat(m.get("correlationId").asText()).isEqualTo("corr-java-0001");
                assertThat(m.get("payload").toString()).isEqualTo("{\"candidateId\":\"c1\",\"status\":\"HIRED\"}");
                assertThat(m.fieldNames()).toIterable().containsExactlyInAnyOrder("v", "id", "type", "channel", "ts", "correlationId", "source", "payload");
                // the same field set the TypeScript hub accepts (fixtures/contracts/channels/envelope.json is shared with the TypeScript tests)
                JsonNode fx = M.readTree(new File("../../fixtures/contracts/channels/envelope.json"));
                assertThat(m.fieldNames()).toIterable().allMatch(f -> Set.of(M.convertValue(fx.get("allowedKeys"), String[].class)).contains(f));
            } finally {
                MDC.remove("correlationId");
            }
        });
    }

    @Test
    void bestEffortInsideATransactionIsSentOnlyAfterCommitAndNeverOnRollback() {
        runner().run(ctx -> {
            RecruitmentService svc = ctx.getBean(RecruitmentService.class);
            MemoryAdapter a = ctx.getBean(MemoryAdapter.class);
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            TransactionTemplate tx = new TransactionTemplate(ctx.getBean(PlatformTransactionManager.class));
            // before commit nothing has been sent
            tx.executeWithoutResult(s -> {
                PsoChannelPublisher.Outcome o = ctx.getBean(PsoChannelPublisher.class).publish("candidate.c1", "candidate.updated", new CandidateUpdated("c1", "X"));
                assertThat(o.status()).isEqualTo(PsoChannelPublisher.Status.SCHEDULED_AFTER_COMMIT);
                assertThat(a.messages("channels-events")).isEmpty();
            });
            assertThat(a.messages("channels-events")).hasSize(1);
            // rollback: no event
            tx.executeWithoutResult(s -> {
                ctx.getBean(PsoChannelPublisher.class).publish("candidate.c1", "candidate.updated", new CandidateUpdated("c1", "Y"));
                s.setRollbackOnly();
            });
            assertThat(a.messages("channels-events")).hasSize(1);
            // the annotation: success commits and publishes exactly once; a business exception rolls back and publishes nothing
            svc.updateBestEffort("c2", "HIRED", false);
            assertThat(a.messages("channels-events")).hasSize(2);
            assertThat(envelopeOf(a, 1).get("channel").asText()).isEqualTo("candidate.c2");
            assertThatThrownBy(() -> svc.updateBestEffort("c3", "HIRED", true)).hasMessage("business rule violated");
            assertThat(a.messages("channels-events")).hasSize(2);
            assertThat(count(jdbc, "candidate")).isEqualTo(1);
            assertThat(ctx.getBean(PsoChannelPublisher.class).metrics().scheduled()).isEqualTo(3);
        });
    }

    @Test
    void durableDeliveryIsAtomicWithTheBusinessChange() {
        runner("pso.dispatch.outbox.enabled=false").run(ctx -> {
            RecruitmentService svc = ctx.getBean(RecruitmentService.class);
            Outbox outbox = ctx.getBean(Outbox.class);
            MemoryAdapter a = ctx.getBean(MemoryAdapter.class);
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            svc.updateDurable("c1", "INTERVIEW", false);
            assertThat(count(jdbc, "candidate")).isEqualTo(1);
            assertThat(count(jdbc, "pso_outbox")).as("the event is stored in the same transaction as the data").isEqualTo(1);
            assertThat(a.messages("channels-events")).as("nothing is on the transport until the outbox relays").isEmpty();
            // rollback removes both: no data, no event
            assertThatThrownBy(() -> svc.updateDurable("c2", "INTERVIEW", true)).hasMessage("business rule violated");
            assertThat(count(jdbc, "candidate")).isEqualTo(1);
            assertThat(count(jdbc, "pso_outbox")).isEqualTo(1);
            // the relay hands the committed event to Dispatch, with the stable event id
            String idStored = jdbc.queryForObject("SELECT id FROM pso_outbox", String.class);
            assertThat(outbox.relayOnce()).isEqualTo(1);
            assertThat(a.messages("channels-events")).hasSize(1);
            assertThat(envelopeOf(a, 0).get("id").asText()).isEqualTo(Envelope.parse(a.messages("channels-events").get(0).body()).id());
            assertThat(envelopeOf(a, 0).get("channel").asText()).isEqualTo("candidate.c1");
            assertThat(idStored).isEqualTo(Envelope.parse(a.messages("channels-events").get(0).body()).id());
            assertThat(outbox.relayOnce()).as("an event is relayed once").isZero();
        });
    }

    @Test
    void durableNeverDowngrades() {
        // no outbox bean: the annotation is refused at start-up
        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PsoAutoConfiguration.class, DataSourceAutoConfiguration.class, DataSourceTransactionManagerAutoConfiguration.class, JdbcTemplateAutoConfiguration.class,
                TransactionAutoConfiguration.class, AopAutoConfiguration.class, PsoChannelsAutoConfiguration.class))
            .withUserConfiguration(NoOutbox.class)
            .withPropertyValues("pso.service.name=recruitment-service", "pso.channels.enabled=true", "spring.datasource.url=jdbc:h2:mem:chn;DB_CLOSE_DELAY=-1")
            .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("DURABLE needs the transactional outbox").hasMessageContaining("never downgraded"));
        // programmatic durable without a transaction, and without an outbox, both fail loudly
        runner().run(ctx -> {
            PsoChannelPublisher p = ctx.getBean(PsoChannelPublisher.class);
            assertThatThrownBy(() -> p.publish("candidate.c1", "candidate.updated", new CandidateUpdated("c1", "X"), PsoChannelPublisher.Options.durable()))
                .isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_DURABLE_UNAVAILABLE"));
            assertThatThrownBy(() -> ctx.getBean(RecruitmentService.class).durableWithoutTransaction()).isInstanceOf(ChannelPublishException.class).hasMessageContaining("active transaction");
            assertThat(ctx.getBean(MemoryAdapter.class).messages("channels-events")).isEmpty();
        });
    }

    static class NoOutbox {
        @Bean
        DispatchRuntime dispatch() throws Exception {
            return new Infra().dispatch();
        }

        @Bean
        RecruitmentService recruitmentService(PsoChannelPublisher p, JdbcTemplate j) {
            return new RecruitmentService(p, j);
        }
    }

    @Test
    void theAnnotationPublishesOncePerInvocationAndHandlesNullAndSelfInvocation() {
        runner().run(ctx -> {
            RecruitmentService svc = ctx.getBean(RecruitmentService.class);
            MemoryAdapter a = ctx.getBean(MemoryAdapter.class);
            svc.noTransaction();
            assertThat(a.messages("channels-events")).hasSize(1);
            assertThat(svc.nothingToReport()).isNull();
            assertThat(a.messages("channels-events")).as("a null return publishes nothing").hasSize(1);
            svc.callsAnotherMethodOfThisObject();
            assertThat(a.messages("channels-events")).as("self-invocation is not proxied: one event for the outer call only if it were annotated").hasSize(1);
        });
    }

    @Test
    void invalidEventsAreRefusedBeforeAnythingIsSent() {
        runner().withPropertyValues("pso.channels.max-payload=200B").run(ctx -> {
            PsoChannelPublisher p = ctx.getBean(PsoChannelPublisher.class);
            MemoryAdapter a = ctx.getBean(MemoryAdapter.class);
            record Big(String text) {
            }
            String ok = "candidate.c1";
            for (String bad : List.of("Candidate.c1", "candidate.{id}", "candidate..c1", "candidate.c1.x.y.z.a.b.c.d", "", "candidate.a b", "../x", "candidate.c1\n")) {
                assertThatThrownBy(() -> p.publish(bad, "candidate.updated", new CandidateUpdated("c1", "X"))).as(bad).isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_INVALID_CHANNEL"));
            }
            for (String bad : List.of("Candidate.Updated", "candidate updated", "", ".x", "x.")) {
                assertThatThrownBy(() -> p.publish(ok, bad, new CandidateUpdated("c1", "X"))).as(bad).isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_INVALID_EVENT"));
            }
            assertThatThrownBy(() -> p.publish(ok, "a.b", "just a string")).isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_INVALID_PAYLOAD"));
            assertThatThrownBy(() -> p.publish(ok, "a.b", List.of(1))).isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_INVALID_PAYLOAD"));
            assertThatThrownBy(() -> p.publish(ok, "a.b", null)).isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_INVALID_PAYLOAD"));
            assertThatThrownBy(() -> p.publish(ok, "a.b", new Big("x".repeat(500)))).isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.code()).isEqualTo("PSO_CHANNEL_PAYLOAD_TOO_LARGE").as("never echoes content").satisfies(c -> assertThat(e.getMessage()).doesNotContain("xxxx")));
            assertThatThrownBy(() -> p.publish(ok, "a.b", new CandidateUpdated("c1", "X"), new PsoChannelPublisher.Options(PsoChannelPublisher.Delivery.BEST_EFFORT, "short", null))).isInstanceOf(ChannelPublishException.class);
            assertThat(a.messages("channels-events")).isEmpty();
            assertThat(p.metrics().rejected()).isGreaterThanOrEqualTo(17);
        });
    }

    @Test
    void unsupportedAnnotationDeclarationsFailAtStartUp() {
        class Void1 {
            @ChannelPublish(channel = "x", event = "a.b")
            public void nothing() {
            }
        }
        class Str {
            @ChannelPublish(channel = "x", event = "a.b")
            public String text() {
                return "x";
            }
        }
        class BadEvent {
            @ChannelPublish(channel = "x", event = "Bad Event")
            public CandidateUpdated e() {
                return null;
            }
        }
        class BadChannel {
            @ChannelPublish(channel = "Bad Channel", event = "a.b")
            public CandidateUpdated e() {
                return null;
            }
        }
        for (Object bean : List.of(new Void1(), new Str(), new BadEvent(), new BadChannel())) {
            assertThatThrownBy(() -> new ChannelPublishAspect.Validator(() -> true).postProcessAfterInitialization(bean, "b")).isInstanceOf(org.springframework.beans.factory.BeanInitializationException.class);
        }
    }

    @Test
    void channelsRequireDispatchAndAreOffByDefault() {
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(PsoAutoConfiguration.class, com.pso.spring.autoconfigure.dispatch.PsoDispatchAutoConfiguration.class, PsoChannelsAutoConfiguration.class))
            .withPropertyValues("pso.service.name=recruitment-service").run(ctx -> assertThat(ctx).doesNotHaveBean(PsoChannelPublisher.class));
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(PsoAutoConfiguration.class, com.pso.spring.autoconfigure.dispatch.PsoDispatchAutoConfiguration.class, PsoChannelsAutoConfiguration.class))
            .withPropertyValues("pso.service.name=recruitment-service", "pso.channels.enabled=true")
            .run(ctx -> {
                assertThat(ctx).hasNotFailed();
                assertThatThrownBy(() -> ctx.getBean(PsoChannelPublisher.class).publish("candidate.c1", "candidate.updated", new CandidateUpdated("c1", "X")))
                    .isInstanceOfSatisfying(ChannelPublishException.class, e -> assertThat(e.getMessage()).contains("Dispatch").contains("pso.dispatch.enabled=true"));
            });
        assertThat(PsoDispatch.Disabled.class).isNotNull();
    }
}
