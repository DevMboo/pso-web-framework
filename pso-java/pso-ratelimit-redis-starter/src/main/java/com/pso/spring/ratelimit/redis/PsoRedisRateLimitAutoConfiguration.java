package com.pso.spring.ratelimit.redis;

import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.PsoWebAutoConfiguration;
import com.pso.spring.autoconfigure.ratelimit.PolicyRateLimiter;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/** Active only with {@code pso.limits.requests.provider=redis}; nothing connects to Redis otherwise, even with this starter on the classpath. */
@AutoConfiguration(before = PsoWebAutoConfiguration.class)
@ConditionalOnProperty(prefix = "pso.limits.requests", name = "provider", havingValue = "redis")
public class PsoRedisRateLimitAutoConfiguration {

    @Bean(destroyMethod = "close")
    @ConditionalOnMissingBean(PolicyRateLimiter.class)
    PolicyRateLimiter psoRedisPolicyRateLimiter(PsoProperties props) {
        String url = props.getLimits().getRequests().getRedisUrl();
        if (url == null || url.isBlank()) {
            throw new IllegalStateException("pso.limits.requests.provider=redis requires pso.limits.requests.redis-url (set it from the environment, for example ${RATE_LIMIT_REDIS_URL})");
        }
        return new RedisPolicyRateLimiter(url, props.getLimits().getRequests().getRedisPrefix());
    }
}
