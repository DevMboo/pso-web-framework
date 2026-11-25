package com.pso.dispatch.rabbitmq;

import com.pso.dispatch.DispatchAdapter;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.dispatch.PsoDispatchAutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/** Active only when pso.dispatch.enabled=true AND pso.dispatch.provider=rabbitmq. */
@AutoConfiguration(before = PsoDispatchAutoConfiguration.class)
@ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "true")
@ConditionalOnProperty(prefix = "pso.dispatch", name = "provider", havingValue = "rabbitmq")
public class PsoRabbitmqAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(DispatchAdapter.class)
    DispatchAdapter psoRabbitmqAdapter(PsoProperties props) {
        PsoProperties.DispatchRabbitmq r = props.getDispatch().getRabbitmq();
        if (r.getUrl() == null || !r.getUrl().matches("^amqps?://.+")) {
            throw new IllegalStateException("pso.dispatch.rabbitmq.url must be an amqp:// or amqps:// URL (use ${RABBITMQ_URL}; credentials never belong in the file)");
        }
        return new RabbitMqAdapter(new RabbitMqAdapter.Config(r.getUrl(), r.getExchangePrefix()));
    }
}
