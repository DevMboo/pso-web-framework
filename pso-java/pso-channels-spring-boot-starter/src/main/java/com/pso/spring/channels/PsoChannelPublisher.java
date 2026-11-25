package com.pso.spring.channels;

/**
 * Publishes typed events to PSO Channels (the browsers connected to the orchestrator). Business code never knows a URL, a socket or a
 * connection: the event travels over PSO Dispatch, the framework's service messaging, and the orchestrator delivers it to the clients that
 * were authorized to subscribe.
 *
 * <h3>Delivery semantics (explicit, never silently changed)</h3>
 * <ul>
 *   <li>{@link Delivery#BEST_EFFORT} (the default): an ephemeral notification. Inside a transaction it is sent only after the transaction
 *       COMMITS (nothing is sent on rollback); outside one it is sent immediately. If the transport fails after the commit the event is
 *       lost (it is logged and counted): a browser connection is not a durable queue.</li>
 *   <li>{@link Delivery#DURABLE}: written to the PSO transactional outbox IN THE SAME TRANSACTION as your data (atomic with it), then relayed
 *       to Dispatch with the framework's retries. It requires an active transaction and the outbox
 *       ({@code pso.dispatch.outbox.enabled=true}); when either is missing it FAILS instead of downgrading to best effort. Delivery to the
 *       outbox is at-least-once: the event id is stable, and the orchestrator suppresses duplicates it has already delivered. It is not
 *       exactly-once, and a client that is offline when the event is delivered does not receive it later (no replay).</li>
 * </ul>
 */
public interface PsoChannelPublisher {

    enum Delivery { BEST_EFFORT, DURABLE }

    enum Status {
        /** durable: the event is in the outbox, in your transaction */
        STORED_IN_OUTBOX,
        /** best effort inside a transaction: it will be sent after commit */
        SCHEDULED_AFTER_COMMIT,
        /** handed to the Dispatch transport; {@code acknowledgement} says what the transport guaranteed */
        SENT
    }

    /** @param eventId stable id (also the Dispatch envelope id): use it for idempotent downstream handling; null generates one */
    record Options(Delivery delivery, String eventId, String correlationId) {
        public static Options bestEffort() {
            return new Options(Delivery.BEST_EFFORT, null, null);
        }

        public static Options durable() {
            return new Options(Delivery.DURABLE, null, null);
        }
    }

    /** What happened, precisely. {@code acknowledgement} is the transport's own statement (see the Dispatch provider capabilities) or a fixed description for the other statuses. */
    record Outcome(String eventId, Delivery delivery, Status status, String acknowledgement) {
    }

    /**
     * @param channel   a concrete channel name (for example {@code candidate.3f2a...}); validated, never a pattern
     * @param eventType a dotted lower-case event type such as {@code candidate.updated}
     * @param payload   the event contract (a record or bean); it must serialize to a JSON object within {@code pso.channels.max-payload}
     * @throws ChannelPublishException when the event is invalid, the requested delivery is unavailable, or the transport refuses it
     */
    Outcome publish(String channel, String eventType, Object payload, Options options);

    default Outcome publish(String channel, String eventType, Object payload) {
        return publish(channel, eventType, payload, Options.bestEffort());
    }

    /** Counters since start-up. */
    Metrics metrics();

    record Metrics(long sent, long storedInOutbox, long scheduled, long failedAfterCommit, long rejected) {
    }
}
