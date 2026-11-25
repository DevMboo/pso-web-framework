package com.pso.spring.autoconfigure.ratelimit;

/**
 * One token-bucket policy: {@code burst} tokens, refilled at {@code limit} per {@code windowSeconds}. The same model as the TypeScript
 * orchestrator ({@code RatePolicy}); the behavioral contract is in the "Rate limiting" documentation and in the shared fixture
 * {@code fixtures/contracts/ratelimit/contract.json}.
 */
public record RatePolicy(int limit, int windowSeconds, int burst) {

    public RatePolicy {
        if (limit < 1 || windowSeconds < 1 || burst < 1) {
            throw new IllegalArgumentException("limit, windowSeconds and burst must be at least 1");
        }
    }

    /** Tokens added per millisecond. */
    public double refillPerMillis() {
        return (double) limit / (windowSeconds * 1000.0);
    }
}
