package com.pso.dispatch.kafka;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.Envelope;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.apache.kafka.common.serialization.ByteArrayDeserializer;
import org.apache.kafka.common.serialization.ByteArraySerializer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;

/**
 * Kafka (and Redpanda): topic = channel, partition key = the event key (ordering only per key / partition, never global), producer
 * acks=all with idempotence, consumer groups, offsets committed only AFTER the handler succeeded. A message that is being retried
 * blocks later messages of its partition, so retries are bounded.
 */
public final class KafkaAdapter implements DispatchAdapter {

    public record Config(List<String> bootstrapServers, String clientId, boolean createTopics, int partitions, int replicationFactor, boolean ssl,
                         String saslMechanism, String saslUsername, String saslPassword) {
    }

    private final Config cfg;
    private KafkaProducer<String, byte[]> producer;
    private Admin admin;
    private final Set<String> topics = new HashSet<>();

    public KafkaAdapter(Config cfg) {
        this.cfg = cfg;
    }

    @Override
    public Capabilities capabilities() {
        return new Capabilities("kafka", "acks=all: acknowledged by all in-sync replicas (durability depends on min.insync.replicas)", "per-key", true);
    }

    private Properties base() {
        Properties p = new Properties();
        p.put("bootstrap.servers", String.join(",", cfg.bootstrapServers()));
        p.put("client.id", cfg.clientId());
        if (cfg.ssl()) {
            p.put("security.protocol", cfg.saslMechanism() != null ? "SASL_SSL" : "SSL");
        }
        if (cfg.saslMechanism() != null) {
            String mech = switch (cfg.saslMechanism()) {
                case "plain" -> "PLAIN";
                case "scram-sha-256" -> "SCRAM-SHA-256";
                default -> "SCRAM-SHA-512";
            };
            String module = mech.equals("PLAIN") ? "org.apache.kafka.common.security.plain.PlainLoginModule" : "org.apache.kafka.common.security.scram.ScramLoginModule";
            p.put("sasl.mechanism", mech);
            p.put("sasl.jaas.config", module + " required username=\"" + cfg.saslUsername().replace("\"", "") + "\" password=\"" + cfg.saslPassword().replace("\"", "") + "\";");
        }
        return p;
    }

    @Override
    public synchronized void connect() {
        try {
            admin = Admin.create(base());
            admin.listTopics().names().get(15, TimeUnit.SECONDS); // proves the brokers are reachable
            Properties p = base();
            p.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
            p.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, ByteArraySerializer.class.getName());
            p.put(ProducerConfig.ACKS_CONFIG, "all");
            p.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true");
            p.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, "30000");
            p.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, "15000");
            producer = new KafkaProducer<>(p);
        } catch (Exception e) {
            if (admin != null) {
                admin.close(Duration.ofSeconds(1));
                admin = null;
            }
            throw new DispatchException("PSO_DISPATCH_CONNECT", "cannot connect to Kafka (" + e.getClass().getSimpleName() + ")", e);
        }
    }

    private void ensureTopic(String topic) {
        synchronized (topics) {
            if (topics.contains(topic)) {
                return;
            }
            try {
                if (!admin.listTopics().names().get(15, TimeUnit.SECONDS).contains(topic)) {
                    if (!cfg.createTopics()) {
                        throw new DispatchException("PSO_DISPATCH_TOPOLOGY_MISSING", "topic \"" + topic + "\" does not exist and pso.dispatch.kafka.topic-creation is REQUIRE");
                    }
                    try {
                        admin.createTopics(List.of(new NewTopic(topic, cfg.partitions(), (short) cfg.replicationFactor()))).all().get(30, TimeUnit.SECONDS);
                    } catch (ExecutionException e) {
                        if (!(e.getCause() instanceof org.apache.kafka.common.errors.TopicExistsException)) {
                            throw e;
                        }
                    }
                }
                topics.add(topic);
            } catch (DispatchException e) {
                throw e;
            } catch (Exception e) {
                throw new DispatchException("PSO_DISPATCH_TOPOLOGY", "cannot prepare topic " + topic + " (" + e.getClass().getSimpleName() + ")", e);
            }
        }
    }

    @Override
    public PublishResult publish(String channel, Envelope e, PublishOptions o) {
        return send(channel, e.bytes(), o, e.id());
    }

    @Override
    public PublishResult publishRaw(String channel, byte[] body, PublishOptions o) {
        return send(channel, body, o, null);
    }

    private PublishResult send(String channel, byte[] body, PublishOptions o, String id) {
        if (producer == null) {
            throw new DispatchException("PSO_DISPATCH_NOT_CONNECTED", "Kafka adapter is not connected");
        }
        ensureTopic(channel);
        List<Header> headers = new ArrayList<>();
        if (o.headers() != null) {
            o.headers().forEach((k, v) -> headers.add(new RecordHeader(k, v.getBytes(StandardCharsets.UTF_8))));
        }
        try {
            RecordMetadata m = producer.send(new ProducerRecord<>(channel, null, o.key(), body, headers)).get(o.timeoutMillis() > 0 ? o.timeoutMillis() : 30_000, TimeUnit.MILLISECONDS);
            return new PublishResult(id != null ? id : m.partition() + ":" + m.offset(), channel, "kafka", m.partition() + ":" + m.offset(), capabilities().publishAck());
        } catch (java.util.concurrent.TimeoutException e) {
            throw new DispatchException("PSO_DISPATCH_TIMEOUT", "publish to " + channel + " timed out");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publish to " + channel + " was interrupted");
        } catch (ExecutionException e) {
            throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publish to " + channel + " failed (" + e.getCause().getClass().getSimpleName() + ")", e.getCause());
        }
    }

    private static final class Slot {
        final ConsumerRecord<String, byte[]> record;
        volatile boolean acked;

        Slot(ConsumerRecord<String, byte[]> r) {
            this.record = r;
        }
    }

    @Override
    public SubscriptionHandle subscribe(Subscription s) {
        ensureTopic(s.channel());
        Properties p = base();
        p.put(ConsumerConfig.GROUP_ID_CONFIG, s.group());
        p.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        p.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, ByteArrayDeserializer.class.getName());
        p.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        p.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        p.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, String.valueOf(s.batchSize()));
        p.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "15000");
        p.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "300000");
        KafkaConsumer<String, byte[]> consumer = new KafkaConsumer<>(p);
        consumer.subscribe(List.of(s.channel()));
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        Semaphore partitions = new Semaphore(s.concurrency());
        AtomicInteger inFlight = new AtomicInteger();
        boolean[] running = {true};
        Thread loop = Thread.ofPlatform().name("pso-kafka-" + s.channel()).start(() -> {
            try {
                while (running[0]) {
                    ConsumerRecords<String, byte[]> records = consumer.poll(Duration.ofMillis(300));
                    if (records.isEmpty()) {
                        continue;
                    }
                    Map<TopicPartition, List<Slot>> byPartition = new LinkedHashMap<>();
                    for (ConsumerRecord<String, byte[]> r : records) {
                        byPartition.computeIfAbsent(new TopicPartition(r.topic(), r.partition()), k -> new ArrayList<>()).add(new Slot(r));
                    }
                    Map<TopicPartition, Future<?>> futures = new HashMap<>();
                    for (Map.Entry<TopicPartition, List<Slot>> e : byPartition.entrySet()) {
                        futures.put(e.getKey(), pool.submit(() -> {
                            try {
                                partitions.acquire();
                            } catch (InterruptedException ie) {
                                return;
                            }
                            try {
                                for (Slot slot : e.getValue()) {
                                    inFlight.incrementAndGet();
                                    try {
                                        Map<String, String> headers = new HashMap<>();
                                        for (Header h : slot.record.headers()) {
                                            headers.put(h.key(), new String(h.value(), StandardCharsets.UTF_8));
                                        }
                                        Delivery d = new Delivery() {
                                            @Override public String channel() { return s.channel(); }
                                            @Override public byte[] body() { return slot.record.value(); }
                                            @Override public Map<String, String> headers() { return headers; }
                                            @Override public void ack() { slot.acked = true; }
                                            @Override public void nack() { slot.acked = false; }
                                        };
                                        try {
                                            s.handler().onMessage(d);
                                        } catch (Exception ex) {
                                            slot.acked = false;
                                        }
                                    } finally {
                                        inFlight.decrementAndGet();
                                    }
                                    if (!slot.acked) {
                                        break; // later messages of this partition wait: the failed one is redelivered first
                                    }
                                }
                            } finally {
                                partitions.release();
                            }
                        }));
                    }
                    Map<TopicPartition, OffsetAndMetadata> commit = new HashMap<>();
                    for (Map.Entry<TopicPartition, Future<?>> f : futures.entrySet()) {
                        try {
                            f.getValue().get();
                        } catch (ExecutionException | InterruptedException ignored) {
                            // treated as not acknowledged below
                        }
                        List<Slot> slots = byPartition.get(f.getKey());
                        long next = -1;
                        for (Slot slot : slots) {
                            if (!slot.acked) {
                                consumer.seek(f.getKey(), slot.record.offset()); // redeliver from the first unacknowledged message
                                break;
                            }
                            next = slot.record.offset() + 1;
                        }
                        if (next >= 0) {
                            commit.put(f.getKey(), new OffsetAndMetadata(next));
                        }
                    }
                    if (!commit.isEmpty()) {
                        consumer.commitSync(commit);
                    }
                }
            } catch (org.apache.kafka.common.errors.WakeupException ignored) {
                // stop requested
            } finally {
                try {
                    consumer.close(Duration.ofSeconds(5));
                } catch (RuntimeException ignored) {
                    // already closed
                }
            }
        });
        return timeout -> {
            running[0] = false;
            consumer.wakeup();
            try {
                loop.join(timeout + 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            pool.shutdownNow();
        };
    }

    /** Consumer lag of a group on a topic (diagnostics). */
    public long lag(String channel, String group) {
        try {
            var committed = admin.listConsumerGroupOffsets(group).partitionsToOffsetAndMetadata().get(15, TimeUnit.SECONDS);
            Map<TopicPartition, org.apache.kafka.clients.admin.OffsetSpec> req = new HashMap<>();
            for (var pi : admin.describeTopics(List.of(channel)).allTopicNames().get(15, TimeUnit.SECONDS).get(channel).partitions()) {
                req.put(new TopicPartition(channel, pi.partition()), org.apache.kafka.clients.admin.OffsetSpec.latest());
            }
            long lag = 0;
            for (var e : admin.listOffsets(req).all().get(15, TimeUnit.SECONDS).entrySet()) {
                OffsetAndMetadata c = committed.get(e.getKey());
                lag += Math.max(0, e.getValue().offset() - (c == null ? 0 : c.offset()));
            }
            return lag;
        } catch (Exception e) {
            return -1;
        }
    }

    @Override
    public Health health() {
        try {
            admin.listTopics().names().get(10, TimeUnit.SECONDS);
            return new Health(true, "metadata request answered");
        } catch (Exception e) {
            return new Health(false, "metadata request failed (" + e.getClass().getSimpleName() + ")");
        }
    }

    @Override
    public synchronized void close() {
        if (producer != null) {
            producer.close(Duration.ofSeconds(5));
            producer = null;
        }
        if (admin != null) {
            admin.close(Duration.ofSeconds(5));
            admin = null;
        }
    }
}
