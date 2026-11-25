package com.pso.spring.autoconfigure.problem;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/** One error standard for every PSO Spring service: RFC 9457 Problem Details with stable PSO codes. */
@AutoConfiguration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnClass(ResponseEntityExceptionHandler.class)
public class PsoProblemAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(PsoProblemAdvice.class)
    PsoProblemAdvice psoProblemAdvice(org.springframework.core.env.Environment environment) {
        boolean requested = environment.getProperty("pso.observability.error-details", Boolean.class, false);
        boolean production = com.pso.spring.autoconfigure.PsoEnvironment.isProduction(environment);
        if (requested && production) {
            org.slf4j.LoggerFactory.getLogger(PsoProblemAdvice.class)
                .warn("pso.observability.error-details is ignored in production: the messages and stack traces of unexpected exceptions are not logged");
        }
        return new PsoProblemAdvice(requested && !production);
    }
}
