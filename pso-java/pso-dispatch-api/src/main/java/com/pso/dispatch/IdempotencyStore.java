package com.pso.dispatch;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * Remembers processed event ids per consumer group. Production use needs a durable, shared store (for example the Redis one).
 *
 * <p>{@code has} / {@code add} are the original contract (check, run, record): on their own they are NOT atomic, so two consumers that
 * receive the same event at the same moment both run the handler. The claim methods close that window: the runtime claims the id
 * atomically BEFORE the handler runs, renews the lease while it runs and turns it into a completion record afterwards. The stores
 * shipped with the framework override them atomically; a custom store that implements only has/add inherits the defaults below and
 * keeps the original (non-atomic) guarantee.
 */
public interface IdempotencyStore {

    /** Outcome of a claim: this owner may run the handler, another owner holds a live lease, or the event was already processed. */
    enum Claim { CLAIMED, BUSY, DONE }

    boolean has(String key);

    void add(String key, long ttlMillis);

    /** Atomically: completed gives DONE; a live lease of another owner gives BUSY; otherwise the lease is taken (or extended) for {@code owner}. */
    default Claim claim(String key, String owner, long leaseMillis) {
        return has(key) ? Claim.DONE : Claim.CLAIMED;
    }

    /** Extends the lease when {@code owner} still holds it; false means it was lost (expired and possibly taken by someone else). */
    default boolean renew(String key, String owner, long leaseMillis) {
        return true;
    }

    /** Records completion. True when recorded (the owner held the lease, or nobody did); false when ANOTHER owner holds it now. */
    default boolean complete(String key, String owner, long ttlMillis) {
        add(key, ttlMillis);
        return true;
    }

    /** Gives the lease back (the handler failed): only the owner's own lease is removed, never another owner's or a completion record. */
    default void release(String key, String owner) {
    }

    /** Bounded in-memory store: oldest entries are evicted and entries expire. Per process only; it does not survive a restart. */
    final class Memory implements IdempotencyStore {
        private final Map<String, Long> seen = new LinkedHashMap<>();
        /** leases of handlers that are running right now: key to {owner, expiry} */
        private final Map<String, Object[]> leases = new java.util.HashMap<>();
        private final int max;
        private final LongSupplier clock;

        public Memory(int max, LongSupplier clock) {
            this.max = max;
            this.clock = clock;
        }

        public Memory() {
            this(50_000, System::currentTimeMillis);
        }

        @Override
        public synchronized boolean has(String key) {
            Long exp = seen.get(key);
            if (exp == null) {
                return false;
            }
            if (exp < clock.getAsLong()) {
                seen.remove(key);
                return false;
            }
            return true;
        }

        @Override
        public synchronized void add(String key, long ttlMillis) {
            seen.remove(key);
            if (seen.size() >= max) {
                seen.remove(seen.keySet().iterator().next());
            }
            seen.put(key, clock.getAsLong() + ttlMillis);
        }

        @Override
        public synchronized Claim claim(String key, String owner, long leaseMillis) {
            if (has(key)) {
                return Claim.DONE;
            }
            Object[] l = leases.get(key);
            if (l != null && !l[0].equals(owner) && (long) l[1] >= clock.getAsLong()) {
                return Claim.BUSY;
            }
            leases.put(key, new Object[] {owner, clock.getAsLong() + leaseMillis});
            return Claim.CLAIMED;
        }

        @Override
        public synchronized boolean renew(String key, String owner, long leaseMillis) {
            Object[] l = leases.get(key);
            if (l == null || !l[0].equals(owner) || (long) l[1] < clock.getAsLong()) {
                return false;
            }
            l[1] = clock.getAsLong() + leaseMillis;
            return true;
        }

        @Override
        public synchronized boolean complete(String key, String owner, long ttlMillis) {
            Object[] l = leases.get(key);
            if (l != null && !l[0].equals(owner) && (long) l[1] >= clock.getAsLong()) {
                return false;
            }
            leases.remove(key);
            add(key, ttlMillis);
            return true;
        }

        @Override
        public synchronized void release(String key, String owner) {
            Object[] l = leases.get(key);
            if (l != null && l[0].equals(owner)) {
                leases.remove(key);
            }
        }
    }
}
