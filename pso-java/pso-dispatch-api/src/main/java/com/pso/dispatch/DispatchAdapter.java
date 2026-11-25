package com.pso.dispatch;

import java.util.Map;

/**
 * The stable contract between the runtime and a transport. Adapters never retry business failures: the runtime owns retry policy.
 * A transport states what it can and cannot do through {@link Capabilities}.
 */
public interface DispatchAdapter {

    /** What a transport guarantees. {@code publishAck} is the strongest statement made when publish returns. */
    record Capabilities(String provider, String publishAck, String ordering, boolean lag) {
    }

    /** A message handed to the runtime; it stays unacknowledged (redelivered after a crash) until ack() or nack(). */
    interface Delivery {
        String channel();

        byte[] body();

        Map<String, String> headers();

        void ack();

        /** give the message back for redelivery */
        void nack();
    }

    @FunctionalInterface
    interface MessageHandler {
        void onMessage(Delivery delivery) throws Exception;
    }

    record Subscription(String channel, String group, int concurrency, int batchSize, MessageHandler handler) {
    }

    interface SubscriptionHandle {
        /** stop fetching, wait (bounded) for messages in flight, release the consumer */
        void stop(long timeoutMillis);
    }

    record PublishOptions(String key, long timeoutMillis, Map<String, String> headers) {
        public static PublishOptions none() {
            return new PublishOptions(null, 0, Map.of());
        }
    }

    record PublishResult(String id, String channel, String provider, String position, String acknowledgement) {
    }

    record Health(boolean up, String detail) {
    }

    Capabilities capabilities();

    void connect();

    PublishResult publish(String channel, Envelope envelope, PublishOptions options);

    /** publishes raw bytes (dead letters may hold messages that are not valid envelopes) */
    PublishResult publishRaw(String channel, byte[] body, PublishOptions options);

    SubscriptionHandle subscribe(Subscription subscription);

    Health health();

    void close();
}
