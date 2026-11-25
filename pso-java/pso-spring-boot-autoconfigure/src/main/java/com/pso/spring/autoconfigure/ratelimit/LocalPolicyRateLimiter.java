package com.pso.spring.autoconfigure.ratelimit;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/** In-process token buckets with bounded key cardinality (least recently used keys are evicted). One budget per JVM. */
public final class LocalPolicyRateLimiter implements PolicyRateLimiter {

    private final int maxKeys;
    private final LongSupplier clock;
    private final Map<String, double[]> buckets = new LinkedHashMap<>(); // key -> {tokens, lastMillis}; insertion order = LRU order
    private final AtomicLong allowed = new AtomicLong();
    private final AtomicLong denied = new AtomicLong();

    public LocalPolicyRateLimiter(int maxKeys) {
        this(maxKeys, System::currentTimeMillis);
    }

    public LocalPolicyRateLimiter(int maxKeys, LongSupplier clock) {
        this.maxKeys = maxKeys;
        this.clock = clock;
    }

    @Override
    public synchronized Decision check(String key, RatePolicy p) {
        long now = clock.getAsLong();
        double[] b = buckets.remove(key); // re-inserted below
        if (b == null) {
            while (buckets.size() >= maxKeys) {
                buckets.remove(buckets.keySet().iterator().next());
            }
            b = new double[] {p.burst(), now};
        }
        b[0] = Math.min(p.burst(), b[0] + (now - b[1]) * p.refillPerMillis());
        b[1] = now;
        buckets.put(key, b);
        if (b[0] >= 1) {
            b[0] -= 1;
            allowed.incrementAndGet();
            return Decision.allowed(p.limit(), (long) Math.floor(b[0]));
        }
        denied.incrementAndGet();
        return Decision.denied(p.limit(), (long) Math.ceil((1 - b[0]) / p.refillPerMillis() / 1000.0));
    }

    @Override
    public synchronized Stats stats() {
        return new Stats(allowed.get(), denied.get(), 0, buckets.size());
    }

    @Override
    public synchronized void close() {
        buckets.clear();
    }
}
