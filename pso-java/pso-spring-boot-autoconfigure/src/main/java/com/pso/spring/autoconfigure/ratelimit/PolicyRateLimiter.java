package com.pso.spring.autoconfigure.ratelimit;

/**
 * The rate limiting SPI: decides whether one more request for {@code key} fits the {@link RatePolicy}. Providers: the in-process
 * {@link LocalPolicyRateLimiter} (default) and the optional Redis starter ({@code pso-ratelimit-redis-starter}) that shares one budget
 * between instances. Implementations must never throw: a backend failure is reported through {@link Decision#backendFailed()}.
 */
public interface PolicyRateLimiter {

    Decision check(String key, RatePolicy policy);

    Stats stats();

    default void close() {
    }

    /**
     * @param remaining tokens left after this request, or -1 when unknown (backend failure)
     * @param backendFailed the limiter could not decide; {@code allowed} then follows the configured failure policy
     */
    record Decision(boolean allowed, int limit, long remaining, long retryAfterSeconds, boolean backendFailed) {
        public static Decision allowed(int limit, long remaining) {
            return new Decision(true, limit, remaining, 0, false);
        }

        public static Decision denied(int limit, long retryAfterSeconds) {
            return new Decision(false, limit, 0, Math.max(1, retryAfterSeconds), false);
        }
    }

    /** @param keys the number of tracked keys, or -1 when the provider cannot tell (Redis) */
    record Stats(long allowed, long denied, long backendFailures, long keys) {
    }
}
