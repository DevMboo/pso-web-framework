package com.pso.spring.ratelimit.redis;

import com.pso.spring.autoconfigure.ratelimit.PolicyRateLimiter;
import com.pso.spring.autoconfigure.ratelimit.RatePolicy;
import io.lettuce.core.ClientOptions;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.ScriptOutputType;
import io.lettuce.core.TimeoutOptions;
import io.lettuce.core.api.StatefulRedisConnection;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One budget shared by every instance. Each decision is ONE atomic Lua script (no read-modify-write race) and the time comes from the
 * Redis server, so instance clock skew cannot grant extra tokens. The script is identical to the TypeScript orchestrator's.
 * Failures never throw: they are reported as {@code backendFailed} and the configured failure policy decides.
 */
public final class RedisPolicyRateLimiter implements PolicyRateLimiter {

    private static final Logger LOG = LoggerFactory.getLogger(RedisPolicyRateLimiter.class);

    static final String LUA = """
        local capacity = tonumber(ARGV[1])
        local refill = tonumber(ARGV[2])
        local ttl = tonumber(ARGV[3])
        local t = redis.call('TIME')
        local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
        local d = redis.call('HMGET', KEYS[1], 't', 'l')
        local tokens = tonumber(d[1])
        local last = tonumber(d[2])
        if tokens == nil then tokens = capacity; last = now end
        tokens = math.min(capacity, tokens + (now - last) * refill)
        local allowed = 0
        local retry = 0
        if tokens >= 1 then tokens = tokens - 1; allowed = 1 else retry = math.ceil((1 - tokens) / refill / 1000) end
        redis.call('HSET', KEYS[1], 't', tostring(tokens), 'l', tostring(now))
        redis.call('PEXPIRE', KEYS[1], ttl)
        return { allowed, math.floor(tokens), retry }
        """;

    private final RedisClient client;
    private final StatefulRedisConnection<String, String> connection;
    private final String prefix;
    private final AtomicLong allowed = new AtomicLong();
    private final AtomicLong denied = new AtomicLong();
    private final AtomicLong failures = new AtomicLong();

    /** Connects and verifies the connection once at start-up so a misconfiguration stops the application instead of failing per request. */
    public RedisPolicyRateLimiter(String url, String prefix) {
        this.prefix = prefix;
        RedisURI uri;
        try {
            uri = RedisURI.create(url);
        } catch (RuntimeException e) {
            throw new IllegalStateException("pso.limits.requests.redis-url is not a valid Redis URL (redis:// or rediss://)");
        }
        uri.setTimeout(Duration.ofMillis(250));
        this.client = RedisClient.create(uri);
        this.client.setOptions(ClientOptions.builder().autoReconnect(true).disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
            .timeoutOptions(TimeoutOptions.enabled(Duration.ofMillis(250))).build());
        try {
            this.connection = client.connect();
            this.connection.sync().ping();
        } catch (RuntimeException e) {
            client.shutdown(); // never leave the client's threads behind; the message carries the class only: the URL may hold credentials
            throw new IllegalStateException("cannot connect to Redis for rate limiting (" + e.getClass().getSimpleName() + ")");
        }
    }

    @Override
    public Decision check(String key, RatePolicy p) {
        long ttl = Math.max(1000, (long) Math.ceil((p.burst() / p.refillPerMillis()) * 2));
        try {
            List<Object> r = connection.sync().eval(LUA, ScriptOutputType.MULTI, new String[] {prefix + key},
                Integer.toString(p.burst()), Double.toString(p.refillPerMillis()), Long.toString(ttl));
            if (((Number) r.get(0)).longValue() == 1) {
                allowed.incrementAndGet();
                return Decision.allowed(p.limit(), ((Number) r.get(1)).longValue());
            }
            denied.incrementAndGet();
            return Decision.denied(p.limit(), ((Number) r.get(2)).longValue());
        } catch (RuntimeException e) {
            long n = failures.incrementAndGet();
            if (n == 1 || n % 100 == 0) {
                LOG.warn("rate limit backend failed ({} failures so far): {}", n, e.getClass().getSimpleName());
            }
            return new Decision(false, p.limit(), -1, 1, true); // the filter applies the failure policy
        }
    }

    @Override
    public Stats stats() {
        return new Stats(allowed.get(), denied.get(), failures.get(), -1);
    }

    @Override
    public void close() {
        try {
            connection.close();
        } finally {
            client.shutdown();
        }
    }
}
