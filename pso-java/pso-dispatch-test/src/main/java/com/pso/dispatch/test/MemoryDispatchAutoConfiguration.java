package com.pso.dispatch.test;

import com.pso.dispatch.DispatchAdapter;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/**
 * The in-process adapter as a dispatch provider for the TESTS of a service: {@code pso.dispatch.provider: memory} in the test
 * profile (what {@code pso dispatch:install} writes into application-test.yml). With it a {@code @SpringBootTest} of a service
 * that enabled Dispatch starts, publishes and runs its {@code @PsoEventHandler} methods without Redis, RabbitMQ or Kafka.
 * <p>
 * It exists only where this artifact is on the classpath, which is the test classpath (the dependency has test scope), and the
 * starter refuses the provider with a production profile. It proves nothing about a broker: delivery, ordering, redelivery after a
 * crash and durability are the business of integration tests against the real provider.
 * <p>
 * The {@link MemoryAdapter} bean can be injected into a test to inspect what was published ({@code adapter.messages(channel)}).
 */
@AutoConfiguration
@ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "true")
public class MemoryDispatchAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(DispatchAdapter.class)
    @ConditionalOnProperty(prefix = "pso.dispatch", name = "provider", havingValue = "memory")
    MemoryAdapter psoMemoryDispatchAdapter() {
        return new MemoryAdapter();
    }
}
