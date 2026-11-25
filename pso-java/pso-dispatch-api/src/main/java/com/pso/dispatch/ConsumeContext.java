package com.pso.dispatch;

/**
 * What a handler may know about the message: the envelope metadata, the attempt number, the consumer group and, when publisher trust is
 * on and the message carried a valid signature, {@code verifiedSource}: the service whose key signed it. Use {@code verifiedSource} (never
 * {@code envelope().source()}, which is whatever the producer wrote) for authorization decisions; it is {@code null} when not verified.
 */
public record ConsumeContext(Envelope envelope, int attempt, String group, String verifiedSource) {

    /** The context of a message whose publisher was not verified (the only kind before publisher trust existed). */
    /**
     * For a handler that acts on WHO published the event (a privileged consumer): the verified publisher, or a refusal. It never
     * falls back to the envelope's claim, whatever the trust mode is, so the message fails and is dead-lettered instead of being
     * authorized on a name anyone on the broker can write.
     */
    public String requireVerifiedSource() {
        if (verifiedSource == null) {
            throw new DispatchException("PSO_DISPATCH_UNTRUSTED", "the publisher of event " + envelope.id() + " is not verified (unsigned, unknown or dispatch trust is off); "
                + "configure the publisher's key and pso.dispatch.trust.mode");
        }
        return verifiedSource;
    }

    public ConsumeContext(Envelope envelope, int attempt, String group) {
        this(envelope, attempt, group, null);
    }
}
