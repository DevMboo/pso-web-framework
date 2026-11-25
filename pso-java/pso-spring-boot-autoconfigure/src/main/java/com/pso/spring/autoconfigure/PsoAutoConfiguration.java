package com.pso.spring.autoconfigure;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.actuate.health.AbstractHealthIndicator;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * Core PSO auto-configuration: typed configuration, service identity, dispatch validation and health. Every bean backs off when
 * the application defines its own; nothing here scans application packages.
 */
@AutoConfiguration
@EnableConfigurationProperties(PsoProperties.class)
public class PsoAutoConfiguration {

    private static final Logger log = LoggerFactory.getLogger(PsoAutoConfiguration.class);

    @Bean
    @ConditionalOnMissingBean
    PsoServiceInfo psoServiceInfo(PsoProperties props, Environment env) {
        String name = firstNonBlank(props.getService().getName(), env.getProperty("spring.application.name"));
        if (name == null) {
            throw new IllegalStateException("pso.service.name is required (or set spring.application.name); example: pso.service.name=users-service");
        }
        String configured = props.getService().getPrefix();
        String prefix;
        try {
            prefix = configured == null || configured.isBlank() ? PsoPrefix.derive(name) : PsoPrefix.normalize(configured);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("pso.service.prefix: " + e.getMessage(), e);
        }
        log.info("PSO service \"{}\" endpoint prefix: {}", name, prefix.isEmpty() ? "(none)" : prefix);
        return new PsoServiceInfo(name, prefix);
    }

    @Bean
    @ConditionalOnClass(AbstractHealthIndicator.class)
    @ConditionalOnMissingBean(name = "psoHealthIndicator")
    AbstractHealthIndicator psoHealthIndicator(PsoServiceInfo info) {
        return new AbstractHealthIndicator("PSO health check failed") {
            @Override
            protected void doHealthCheck(Health.Builder builder) {
                builder.up().withDetail("service", info.name()).withDetail("prefix", info.prefix());
            }
        };
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return null;
    }
}
