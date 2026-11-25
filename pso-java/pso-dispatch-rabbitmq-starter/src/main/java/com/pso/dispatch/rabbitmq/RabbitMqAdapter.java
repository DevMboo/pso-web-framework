package com.pso.dispatch.rabbitmq;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.Envelope;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.BuiltinExchangeType;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.DeliverCallback;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * RabbitMQ: durable topic exchange per channel (routing key = event type), one durable queue per consumer group, persistent messages
 * with publisher confirms, manual acknowledgements, prefetch = concurrency and a durable {@code <channel>.dlq} exchange and queue.
 * Topology is declared with fixed arguments: if it already exists with different arguments RabbitMQ refuses and the error surfaces;
 * PSO never deletes or redeclares existing topology. The client library recovers connections and consumers automatically.
 */
public final class RabbitMqAdapter implements DispatchAdapter {

    public record Config(String url, String exchangePrefix) {
    }

    private final Config cfg;
    private Connection connection;
    private Channel pub;
    private final Set<String> declared = new HashSet<>();
    private final Set<String> returned = ConcurrentHashMap.newKeySet();
    private final List<Channel> channels = new ArrayList<>();

    public RabbitMqAdapter(Config cfg) {
        this.cfg = cfg;
    }

    @Override
    public Capabilities capabilities() {
        return new Capabilities("rabbitmq", "publisher confirm for a persistent message routed to a durable queue", "none", false);
    }

    private String ex(String channel) {
        return cfg.exchangePrefix() + channel;
    }

    @Override
    public synchronized void connect() {
        try {
            ConnectionFactory f = new ConnectionFactory();
            f.setUri(cfg.url());
            f.setAutomaticRecoveryEnabled(true);
            f.setTopologyRecoveryEnabled(true);
            f.setNetworkRecoveryInterval(2000);
            f.setRequestedHeartbeat(15);
            connection = f.newConnection("pso-dispatch");
            pub = connection.createChannel();
            pub.confirmSelect();
            pub.addReturnListener(r -> {
                if (r.getProperties() != null && r.getProperties().getMessageId() != null) {
                    returned.add(r.getProperties().getMessageId());
                }
            });
        } catch (Exception e) {
            throw new DispatchException("PSO_DISPATCH_CONNECT", "cannot connect to RabbitMQ (" + e.getClass().getSimpleName() + ")", e);
        }
    }

    private void declareExchange(Channel ch, String channel) throws java.io.IOException {
        synchronized (declared) {
            if (declared.contains(channel)) {
                return;
            }
            ch.exchangeDeclare(ex(channel), BuiltinExchangeType.TOPIC, true);
            declared.add(channel);
        }
    }

    private void declareDlq(Channel ch, String dlq) throws java.io.IOException {
        declareExchange(ch, dlq);
        ch.queueDeclare(ex(dlq), true, false, false, null);
        ch.queueBind(ex(dlq), ex(dlq), "#");
    }

    @Override
    public PublishResult publish(String channel, Envelope e, PublishOptions o) {
        return send(channel, e.bytes(), e.type(), e.id(), o);
    }

    @Override
    public PublishResult publishRaw(String channel, byte[] body, PublishOptions o) {
        if (channel.endsWith(".dlq")) {
            synchronized (pub) {
                try {
                    declareDlq(pub, channel);
                } catch (java.io.IOException e) {
                    throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "cannot declare " + channel + " (" + e.getClass().getSimpleName() + ")", e);
                }
            }
        }
        return send(channel, body, "dead", null, o);
    }

    private PublishResult send(String channel, byte[] body, String routingKey, String id, PublishOptions o) {
        if (pub == null) {
            throw new DispatchException("PSO_DISPATCH_NOT_CONNECTED", "RabbitMQ adapter is not connected");
        }
        String messageId = id != null ? id : "raw-" + UUID.randomUUID();
        Map<String, Object> headers = new HashMap<>();
        if (o.headers() != null) {
            headers.putAll(o.headers());
        }
        AMQP.BasicProperties props = new AMQP.BasicProperties.Builder().deliveryMode(2).contentType("application/json").messageId(messageId).headers(headers).build();
        synchronized (pub) { // a channel is not safe for concurrent publish + confirm
            try {
                declareExchange(pub, channel);
                pub.basicPublish(ex(channel), routingKey, true, props, body);
                pub.waitForConfirmsOrDie(o.timeoutMillis() > 0 ? o.timeoutMillis() : 30_000);
            } catch (java.util.concurrent.TimeoutException e) {
                throw new DispatchException("PSO_DISPATCH_TIMEOUT", "publish to " + channel + " timed out");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publish to " + channel + " was interrupted");
            } catch (java.io.IOException e) {
                throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publish to " + channel + " failed (" + e.getClass().getSimpleName() + ")", e);
            }
        }
        if (returned.remove(messageId)) {
            throw new DispatchException("PSO_DISPATCH_UNROUTABLE", "no queue is bound to \"" + channel + "\" yet (no consumer group has declared its queue): the message was not accepted");
        }
        return new PublishResult(id != null ? id : messageId, channel, "rabbitmq", null, capabilities().publishAck());
    }

    @Override
    public SubscriptionHandle subscribe(Subscription s) {
        try {
            Channel ch = connection.createChannel();
            synchronized (channels) {
                channels.add(ch);
            }
            declareExchange(ch, s.channel());
            String queue = ex(s.channel()) + "." + s.group();
            ch.queueDeclare(queue, true, false, false, null);
            ch.queueBind(queue, ex(s.channel()), "#");
            declareDlq(ch, s.channel() + ".dlq");
            ch.basicQos(s.concurrency());
            AtomicInteger inFlight = new AtomicInteger();
            DeliverCallback cb = (tag, msg) -> {
                inFlight.incrementAndGet();
                Map<String, String> headers = new HashMap<>();
                if (msg.getProperties().getHeaders() != null) {
                    msg.getProperties().getHeaders().forEach((k, v) -> headers.put(k, String.valueOf(v)));
                }
                Delivery d = new Delivery() {
                    private boolean done;

                    @Override public String channel() { return s.channel(); }
                    @Override public byte[] body() { return msg.getBody(); }
                    @Override public Map<String, String> headers() { return headers; }

                    @Override
                    public void ack() {
                        synchronized (this) {
                            if (done) {
                                return;
                            }
                            done = true;
                        }
                        try {
                            synchronized (ch) {
                                ch.basicAck(msg.getEnvelope().getDeliveryTag(), false);
                            }
                        } catch (java.io.IOException ignored) {
                            // the connection is gone: RabbitMQ redelivers the unacknowledged message
                        } finally {
                            inFlight.decrementAndGet();
                        }
                    }

                    @Override
                    public void nack() {
                        synchronized (this) {
                            if (done) {
                                return;
                            }
                            done = true;
                        }
                        try {
                            Thread.sleep(1000); // never an immediate requeue loop
                            synchronized (ch) {
                                ch.basicNack(msg.getEnvelope().getDeliveryTag(), false, true);
                            }
                        } catch (java.io.IOException | InterruptedException ignored) {
                            // the broker requeues unacknowledged messages itself
                        } finally {
                            inFlight.decrementAndGet();
                        }
                    }
                };
                Thread.ofVirtual().start(() -> {
                    try {
                        s.handler().onMessage(d);
                    } catch (Exception ex) {
                        d.nack();
                    }
                });
            };
            String tag = ch.basicConsume(queue, false, cb, consumerTag -> { });
            return timeout -> {
                try {
                    ch.basicCancel(tag);
                } catch (Exception ignored) {
                    // already closed
                }
                long end = System.currentTimeMillis() + timeout;
                while (inFlight.get() > 0 && System.currentTimeMillis() < end) {
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                try {
                    ch.close();
                } catch (Exception ignored) {
                    // already closed
                }
            };
        } catch (java.io.IOException e) {
            throw new DispatchException("PSO_DISPATCH_SUBSCRIBE", "cannot subscribe to " + s.channel() + " (" + e.getClass().getSimpleName() + ")", e);
        }
    }

    @Override
    public Health health() {
        return connection != null && connection.isOpen() ? new Health(true, "connection open") : new Health(false, "not connected");
    }

    @Override
    public synchronized void close() {
        try {
            if (connection != null) {
                connection.close(5000);
            }
        } catch (Exception ignored) {
            // already closed
        }
        connection = null;
        pub = null;
    }

    static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
