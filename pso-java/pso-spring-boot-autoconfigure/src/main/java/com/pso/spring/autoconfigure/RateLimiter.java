package com.pso.spring.autoconfigure;

/**
 * Decides whether a client may proceed. The default is an in-memory limiter per process; define a bean of this type to plug
 * in a distributed implementation (for example Redis based) when several instances must share one budget.
 */
public interface RateLimiter {

    Decision tryAcquire(String key);

    record Decision(boolean allowed, long retryAfterSeconds) {
    }
}
