package com.pso.spring.http;

import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.autoconfigure.PsoProperties;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.web.client.RestClient;

/** Registers the PSO HTTP client. Configuration errors fail start-up; an application-defined {@link PsoHttpClient} replaces it. */
@AutoConfiguration(after = PsoAutoConfiguration.class)
@ConditionalOnClass(RestClient.class)
public class PsoHttpClientAutoConfiguration {

    /** Client failures become PSO problems (RFC 9457) in servlet applications. */
    @Bean
    @org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication(type = org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type.SERVLET)
    @ConditionalOnMissingBean(PsoHttpProblemAdvice.class)
    PsoHttpProblemAdvice psoHttpProblemAdvice() {
        return new PsoHttpProblemAdvice();
    }

    @Bean
    @ConditionalOnMissingBean(PsoHttpClient.class)
    DefaultPsoHttpClient psoHttpClient(PsoProperties props, org.springframework.beans.factory.ObjectProvider<io.micrometer.observation.ObservationRegistry> observations) {
        return new DefaultPsoHttpClient(props, observations.getIfAvailable());
    }
}
