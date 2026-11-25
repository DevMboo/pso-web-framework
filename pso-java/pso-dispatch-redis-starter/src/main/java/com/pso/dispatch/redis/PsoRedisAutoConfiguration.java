package com.pso.dispatch.redis;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.IdempotencyStore;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.dispatch.PsoDispatchAutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/** Active only when pso.dispatch.enabled=true AND pso.dispatch.provider=redis; otherwise nothing here exists, let alone connects. */
@AutoConfiguration(before = PsoDispatchAutoConfiguration.class)
@ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "true")
@ConditionalOnProperty(prefix = "pso.dispatch", name = "provider", havingValue = "redis")
public class PsoRedisAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(DispatchAdapter.class)
    DispatchAdapter psoRedisAdapter(PsoProperties props) {
        PsoProperties.DispatchRedis r = props.getDispatch().getRedis();
        if (r.getUrl() == null || !r.getUrl().matches("^rediss?://.+")) {
            throw new IllegalStateException("pso.dispatch.redis.url must be a redis:// or rediss:// URL (use ${REDIS_URL}; credentials never belong in the file)");
        }
        return new RedisStreamsAdapter(new RedisStreamsAdapter.Config(r.getUrl(), r.getMaxLength(), r.getMinIdle(), r.getBlock(), r.getStreamCreation() == PsoProperties.TopologyCreation.AUTO));
    }

    /** Durable, shared idempotency for the Redis provider (a different IdempotencyStore bean replaces it). */
    @Bean
    @ConditionalOnMissingBean(IdempotencyStore.class)
    IdempotencyStore psoRedisIdempotency(PsoProperties props) {
        return new RedisStreamsAdapter.Idempotency(props.getDispatch().getRedis().getUrl(), "pso:idem:");
    }
}
