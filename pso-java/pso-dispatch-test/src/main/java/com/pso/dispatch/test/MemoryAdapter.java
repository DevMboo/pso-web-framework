package com.pso.dispatch.test;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.Envelope;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * An in-process adapter for TESTS ONLY. It follows the adapter contract (consumer groups, redelivery after nack) but it is not a
 * broker: nothing is durable and it proves nothing about Redis, RabbitMQ or Kafka behavior.
 */
public final class MemoryAdapter implements DispatchAdapter {

    public record Message(byte[] body, Map<String, String> headers) {
    }

    /** every message ever published, per channel */
    public final Map<String, List<Message>> log = new ConcurrentHashMap<>();
    public final AtomicReference<RuntimeException> failPublish = new AtomicReference<>();
    public final AtomicReference<RuntimeException> failDeadLetter = new AtomicReference<>();
    private final Map<String, AtomicInteger> cursors = new ConcurrentHashMap<>();
    private final Map<String, List<Integer>> redeliver = new ConcurrentHashMap<>();
    private volatile boolean connected;

    @Override
    public Capabilities capabilities() {
        return new Capabilities("memory", "accepted in process memory (not durable)", "per-key", false);
    }

    @Override
    public void connect() {
        connected = true;
    }

    @Override
    public PublishResult publish(String channel, Envelope e, PublishOptions o) {
        return publishRaw(channel, e.bytes(), o);
    }

    @Override
    public PublishResult publishRaw(String channel, byte[] body, PublishOptions o) {
        if (!connected) {
            throw new IllegalStateException("not connected");
        }
        if (failPublish.get() != null) {
            throw failPublish.get();
        }
        if (channel.endsWith(".dlq") && failDeadLetter.get() != null) {
            throw failDeadLetter.get();
        }
        List<Message> list = log.computeIfAbsent(channel, k -> new CopyOnWriteArrayList<>());
        list.add(new Message(body, o.headers() == null ? Map.of() : o.headers()));
        return new PublishResult(String.valueOf(list.size()), channel, "memory", String.valueOf(list.size() - 1), capabilities().publishAck());
    }

    @Override
    public SubscriptionHandle subscribe(Subscription s) {
        String key = s.channel() + "\u0000" + s.group();
        cursors.putIfAbsent(key, new AtomicInteger());
        AtomicInteger inFlight = new AtomicInteger();
        boolean[] running = {true};
        Thread loop = Thread.ofVirtual().start(() -> {
            while (running[0]) {
                if (inFlight.get() >= s.concurrency()) {
                    sleep(5);
                    continue;
                }
                List<Message> list = log.getOrDefault(s.channel(), List.of());
                List<Integer> redo = redeliver.computeIfAbsent(key, k -> new CopyOnWriteArrayList<>());
                int idx;
                synchronized (cursors.get(key)) {
                    if (!redo.isEmpty()) {
                        idx = redo.remove(0);
                    } else if (cursors.get(key).get() < list.size()) {
                        idx = cursors.get(key).getAndIncrement();
                    } else {
                        idx = -1;
                    }
                }
                if (idx < 0) {
                    sleep(5);
                    continue;
                }
                inFlight.incrementAndGet();
                Message m = list.get(idx);
                int i = idx;
                Delivery d = new Delivery() {
                    @Override public String channel() { return s.channel(); }
                    @Override public byte[] body() { return m.body(); }
                    @Override public Map<String, String> headers() { return m.headers(); }
                    @Override public void ack() { inFlight.decrementAndGet(); }
                    @Override public void nack() { inFlight.decrementAndGet(); redo.add(i); }
                };
                Thread.ofVirtual().start(() -> {
                    try {
                        s.handler().onMessage(d);
                    } catch (Exception ex) {
                        d.nack();
                    }
                });
            }
        });
        return timeout -> {
            running[0] = false;
            long end = System.currentTimeMillis() + timeout;
            while (inFlight.get() > 0 && System.currentTimeMillis() < end) {
                sleep(5);
            }
            try {
                loop.join(1000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        };
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public Health health() {
        return new Health(connected, "in-memory test adapter");
    }

    @Override
    public void close() {
        connected = false;
    }

    public List<Message> messages(String channel) {
        return new ArrayList<>(log.getOrDefault(channel, List.of()));
    }
}
