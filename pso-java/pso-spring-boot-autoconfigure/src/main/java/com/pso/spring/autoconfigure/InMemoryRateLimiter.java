package com.pso.spring.autoconfigure;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/** Fixed one-minute window per key with a bounded key table (oldest keys are evicted), so memory cannot grow without limit. */
public class InMemoryRateLimiter implements RateLimiter {

    private static final int MAX_KEYS = 10_000;
    private static final long WINDOW_MS = 60_000;

    private final int perMinute;
    private final LongSupplier clock;
    private final Map<String, long[]> windows = new LinkedHashMap<>(); // key -> {windowStart, count}

    public InMemoryRateLimiter(int perMinute) {
        this(perMinute, System::currentTimeMillis);
    }

    public InMemoryRateLimiter(int perMinute, LongSupplier clock) {
        this.perMinute = perMinute;
        this.clock = clock;
    }

    @Override
    public synchronized Decision tryAcquire(String key) {
        long now = clock.getAsLong();
        long[] w = windows.get(key);
        if (w == null || now - w[0] >= WINDOW_MS) {
            if (w == null && windows.size() >= MAX_KEYS) {
                Iterator<String> it = windows.keySet().iterator();
                it.next();
                it.remove();
            }
            windows.remove(key);
            windows.put(key, new long[] {now, 1});
            return new Decision(true, 0);
        }
        if (w[1] < perMinute) {
            w[1]++;
            return new Decision(true, 0);
        }
        return new Decision(false, Math.max(1, (WINDOW_MS - (now - w[0]) + 999) / 1000));
    }
}
