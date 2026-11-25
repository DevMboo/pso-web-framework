package com.pso.dispatch.kafka;

import com.pso.dispatch.DispatchAdapter;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import com.pso.spring.autoconfigure.dispatch.PsoDispatchAutoConfiguration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/** Active only when pso.dispatch.enabled=true AND pso.dispatch.provider=kafka (Redpanda works the same way). */
@AutoConfiguration(before = PsoDispatchAutoConfiguration.class)
@ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "true")
@ConditionalOnProperty(prefix = "pso.dispatch", name = "provider", havingValue = "kafka")
public class PsoKafkaAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(DispatchAdapter.class)
    DispatchAdapter psoKafkaAdapter(PsoProperties props, PsoServiceInfo service) {
        PsoProperties.DispatchKafka k = props.getDispatch().getKafka();
        List<String> problems = new ArrayList<>();
        if (k.getBootstrapServers().isEmpty()) {
            problems.add("pso.dispatch.kafka.bootstrap-servers needs at least one host:port");
        }
        for (String b : k.getBootstrapServers()) {
            if (!b.matches("^[A-Za-z0-9.-]+:\\d{1,5}$")) {
                problems.add("pso.dispatch.kafka.bootstrap-servers: \"" + b + "\" is not host:port");
            }
        }
        PsoProperties.DispatchKafkaSasl sasl = k.getSasl();
        if (sasl.getMechanism() != null && !sasl.getMechanism().isBlank()) {
            if (!List.of("plain", "scram-sha-256", "scram-sha-512").contains(sasl.getMechanism())) {
                problems.add("pso.dispatch.kafka.sasl.mechanism must be plain, scram-sha-256 or scram-sha-512");
            }
            if (sasl.getUsername() == null || sasl.getUsername().isBlank() || sasl.getPassword() == null || sasl.getPassword().isBlank()) {
                problems.add("pso.dispatch.kafka.sasl needs username and password (use environment variables)");
            }
            if (!k.isSsl()) {
                problems.add("pso.dispatch.kafka.sasl credentials must travel over TLS: set pso.dispatch.kafka.ssl=true");
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Invalid pso.dispatch.kafka configuration:\n - " + String.join("\n - ", problems));
        }
        boolean hasSasl = sasl.getMechanism() != null && !sasl.getMechanism().isBlank();
        return new KafkaAdapter(new KafkaAdapter.Config(k.getBootstrapServers(), k.getClientId() != null ? k.getClientId() : service.name(), k.getTopicCreation() == PsoProperties.TopologyCreation.AUTO,
            k.getPartitions(), k.getReplicationFactor(), k.isSsl(), hasSasl ? sasl.getMechanism() : null, hasSasl ? sasl.getUsername() : null, hasSasl ? sasl.getPassword() : null));
    }
}
