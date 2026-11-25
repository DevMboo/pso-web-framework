package com.pso.it.dispatch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.PsoDispatch;
import com.pso.dispatch.test.MemoryAdapter;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * F-23: the tests of a service that enabled Dispatch must not need a broker. With {@code pso.dispatch.provider=memory} (what
 * {@code pso dispatch:install} writes into the test profile) a real Spring Boot application starts, publishes and consumes in
 * process through the adapter of pso-dispatch-test. The provider is a test tool: a production profile refuses it. What a broker
 * guarantees is still verified against real brokers ({@link DispatchTests}); nothing here replaces those tests.
 */
class MemoryProviderTests {

    private static ConfigurableApplicationContext start(String... extra) {
        List<String> props = new ArrayList<>(List.of("server.port=0", "pso.service.name=memory-service", "logging.level.root=OFF", "pso.security.enabled=false",
            "pso.dispatch.enabled=true", "pso.dispatch.provider=memory", "pso.dispatch.retry.initial-delay=20ms"));
        props.addAll(List.of(extra));
        return new SpringApplicationBuilder(DispatchApp.class).properties(props.toArray(new String[0])).run();
    }

    @Test
    void aServiceWithDispatchEnabledStartsPublishesAndConsumesWithoutABroker() throws Exception {
        try (ConfigurableApplicationContext ctx = start()) {
            assertThat(ctx.getBean(DispatchAdapter.class)).as("no provider starter was activated: nothing connects anywhere").isInstanceOf(MemoryAdapter.class);
            PsoDispatch dispatch = ctx.getBean(PsoDispatch.class);
            DispatchApp.Handlers handlers = ctx.getBean(DispatchApp.Handlers.class);
            dispatch.publish("it.user-created", new DispatchApp.UserCreated("mem", 1, "ok"));
            dispatch.publish("it.user-created", new DispatchApp.UserCreated("mem", 2, "fail-twice"));
            long deadline = System.currentTimeMillis() + 15_000;
            while (handlers.seen.size() < 2 && System.currentTimeMillis() < deadline) {
                Thread.sleep(25);
            }
            assertThat(handlers.seen).as("the @PsoEventHandler ran, with the configured retries").containsExactlyInAnyOrder("mem:1:attempt1", "mem:2:attempt3");
            MemoryAdapter adapter = ctx.getBean(MemoryAdapter.class);
            assertThat(adapter.log.values().stream().mapToInt(List::size).sum()).as("a test can inspect what was published").isGreaterThanOrEqualTo(2);
        }
    }

    @Test
    void theInMemoryProviderIsRefusedInProduction() {
        assertThatThrownBy(() -> start("spring.profiles.active=prod", "pso.dispatch.allow-unauthenticated=true").close())
            .hasStackTraceContaining("pso.dispatch.provider=memory is the in-process test adapter");
        assertThatThrownBy(() -> start("PSO_ENV=production", "pso.dispatch.allow-unauthenticated=true").close())
            .hasStackTraceContaining("pso.dispatch.provider=memory is the in-process test adapter");
    }

    @Test
    void withoutTheTestArtifactTheProviderIsNotAvailable() {
        // the same application with a real provider selected and no broker settings fails to start: the memory adapter is not a fallback
        assertThatThrownBy(() -> start("pso.dispatch.provider=redis").close()).isInstanceOf(Exception.class);
    }
}
