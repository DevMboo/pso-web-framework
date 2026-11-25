package com.pso.dispatch.redis;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.Envelope;
import io.lettuce.core.Consumer;
import io.lettuce.core.RedisBusyException;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisCommandExecutionException;
import io.lettuce.core.StreamMessage;
import io.lettuce.core.XAddArgs;
import io.lettuce.core.XAutoClaimArgs;
import io.lettuce.core.XGroupCreateArgs;
import io.lettuce.core.XReadArgs;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.codec.ByteArrayCodec;
import io.lettuce.core.codec.RedisCodec;
import io.lettuce.core.codec.StringCodec;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Redis Streams (never Pub/Sub): XADD with approximate MAXLEN retention, consumer groups, XREADGROUP, XACK only after processing and
 * recovery of stale pending entries (XAUTOCLAIM) so a crashed consumer's messages are processed by another one.
 */
public final class RedisStreamsAdapter implements DispatchAdapter {

    public record Config(String url, long maxLength, Duration minIdle, Duration block, boolean createStreams) {
    }

    private static final RedisCodec<String, byte[]> CODEC = RedisCodec.of(StringCodec.UTF8, ByteArrayCodec.INSTANCE);

    private final Config cfg;
    private final String consumer = "c-" + ProcessHandle.current().pid() + "-" + UUID.randomUUID().toString().substring(0, 8);
    private RedisClient client;
    private StatefulRedisConnection<String, byte[]> conn;
    private final List<StatefulRedisConnection<String, byte[]>> readers = new ArrayList<>();

    public RedisStreamsAdapter(Config cfg) {
        this.cfg = cfg;
    }

    @Override
    public Capabilities capabilities() {
        return new Capabilities("redis", "XADD acknowledged by Redis: in memory, durable only if the server persists (AOF) or replicates", "per-key", true);
    }

    @Override
    public synchronized void connect() {
        try {
            client = RedisClient.create(cfg.url());
            conn = client.connect(CODEC);
            conn.sync().ping();
        } catch (RuntimeException e) {
            throw new DispatchException("PSO_DISPATCH_CONNECT", "cannot connect to Redis (" + e.getClass().getSimpleName() + ")", e);
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
        if (conn == null) {
            throw new DispatchException("PSO_DISPATCH_NOT_CONNECTED", "Redis adapter is not connected");
        }
        Map<String, byte[]> fields = new HashMap<>();
        fields.put("envelope", body);
        if (o.key() != null) {
            fields.put("key", o.key().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        if (o.headers() != null) {
            o.headers().forEach((k, v) -> fields.put("h:" + k, v.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        }
        try {
            String position = conn.async().xadd(channel, XAddArgs.Builder.maxlen(cfg.maxLength()).approximateTrimming(), fields).get(o.timeoutMillis() > 0 ? o.timeoutMillis() : 30_000, TimeUnit.MILLISECONDS);
            return new PublishResult(id != null ? id : position, channel, "redis", position, capabilities().publishAck());
        } catch (java.util.concurrent.TimeoutException e) {
            throw new DispatchException("PSO_DISPATCH_TIMEOUT", "publish to " + channel + " timed out");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publish to " + channel + " was interrupted");
        } catch (java.util.concurrent.ExecutionException e) {
            throw new DispatchException("PSO_DISPATCH_PUBLISH_FAILED", "publish to " + channel + " failed (" + e.getCause().getClass().getSimpleName() + ")", e.getCause());
        }
    }

    @Override
    public SubscriptionHandle subscribe(Subscription s) {
        if (conn == null) {
            throw new DispatchException("PSO_DISPATCH_NOT_CONNECTED", "Redis adapter is not connected");
        }
        try {
            conn.sync().xgroupCreate(XReadArgs.StreamOffset.from(s.channel(), "0"), s.group(), XGroupCreateArgs.Builder.mkstream(cfg.createStreams()));
        } catch (RedisBusyException ignored) {
            // the group already exists
        } catch (RedisCommandExecutionException e) {
            if (String.valueOf(e.getMessage()).contains("requires the key to exist")) {
                throw new DispatchException("PSO_DISPATCH_TOPOLOGY_MISSING", "stream \"" + s.channel() + "\" does not exist and pso.dispatch.redis.stream-creation is REQUIRE");
            }
            throw new DispatchException("PSO_DISPATCH_SUBSCRIBE", "cannot create consumer group (" + e.getClass().getSimpleName() + ")", e);
        }
        StatefulRedisConnection<String, byte[]> reader = client.connect(CODEC); // dedicated: XREADGROUP BLOCK would stall everything else
        synchronized (readers) {
            readers.add(reader);
        }
        Semaphore permits = new Semaphore(s.concurrency());
        AtomicInteger inFlight = new AtomicInteger();
        boolean[] running = {true};
        Thread loop = Thread.ofVirtual().name("pso-redis-" + s.channel()).start(() -> {
            long lastClaim = 0;
            while (running[0]) {
                try {
                    int free = permits.availablePermits();
                    if (free <= 0) {
                        Thread.sleep(10);
                        continue;
                    }
                    int count = Math.min(free, s.batchSize());
                    List<StreamMessage<String, byte[]>> batch = new ArrayList<>();
                    if (System.currentTimeMillis() - lastClaim > Math.max(500, cfg.minIdle().toMillis() / 2)) {
                        lastClaim = System.currentTimeMillis();
                        var claimed = reader.sync().xautoclaim(s.channel(), XAutoClaimArgs.Builder.xautoclaim(Consumer.from(s.group(), consumer), cfg.minIdle(), "0-0").count(count));
                        if (claimed != null && claimed.getMessages() != null) {
                            batch.addAll(claimed.getMessages());
                        }
                    }
                    if (batch.isEmpty()) {
                        List<StreamMessage<String, byte[]>> read = reader.sync().xreadgroup(Consumer.from(s.group(), consumer), XReadArgs.Builder.count(count).block(cfg.block().toMillis()), XReadArgs.StreamOffset.lastConsumed(s.channel()));
                        if (read != null) {
                            batch.addAll(read);
                        }
                    }
                    for (StreamMessage<String, byte[]> m : batch) {
                        if (m.getBody() == null || m.getBody().isEmpty()) {
                            continue;
                        }
                        permits.acquire();
                        inFlight.incrementAndGet();
                        Thread.ofVirtual().start(() -> {
                            Delivery d = delivery(s, m, permits, inFlight);
                            try {
                                s.handler().onMessage(d);
                            } catch (Exception ex) {
                                d.nack();
                            }
                        });
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (RuntimeException e) {
                    if (!running[0]) {
                        return;
                    }
                    try {
                        Thread.sleep(500); // transient connection problems: Lettuce reconnects; pending messages remain pending
                    } catch (InterruptedException ie) {
                        return;
                    }
                }
            }
        });
        return timeout -> {
            running[0] = false;
            long end = System.currentTimeMillis() + timeout;
            while (inFlight.get() > 0 && System.currentTimeMillis() < end) {
                try {
                    Thread.sleep(10);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            reader.close();
            loop.interrupt();
        };
    }

    private Delivery delivery(Subscription s, StreamMessage<String, byte[]> m, Semaphore permits, AtomicInteger inFlight) {
        Map<String, String> headers = new HashMap<>();
        m.getBody().forEach((k, v) -> {
            if (k.startsWith("h:")) {
                headers.put(k.substring(2), new String(v, java.nio.charset.StandardCharsets.UTF_8));
            }
        });
        byte[] body = m.getBody().get("envelope");
        return new Delivery() {
            private boolean done;

            @Override public String channel() { return s.channel(); }
            @Override public byte[] body() { return body; }
            @Override public Map<String, String> headers() { return headers; }

            @Override
            public synchronized void ack() {
                if (done) {
                    return;
                }
                done = true;
                try {
                    conn.sync().xack(s.channel(), s.group(), m.getId());
                } finally {
                    inFlight.decrementAndGet();
                    permits.release();
                }
            }

            @Override
            public synchronized void nack() {
                if (done) {
                    return;
                }
                done = true; // stays pending: reclaimed after pso.dispatch.redis.min-idle
                inFlight.decrementAndGet();
                permits.release();
            }
        };
    }

    /** Pending entries of a consumer group (diagnostics). */
    public long pending(String channel, String group) {
        try {
            return conn.sync().xpending(channel, group).getCount();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    @Override
    public Health health() {
        try {
            conn.sync().ping();
            return new Health(true, "PING answered");
        } catch (RuntimeException e) {
            return new Health(false, "PING failed (" + e.getClass().getSimpleName() + ")");
        }
    }

    @Override
    public synchronized void close() {
        synchronized (readers) {
            readers.forEach(StatefulRedisConnection::close);
        }
        if (conn != null) {
            conn.close();
            conn = null;
        }
        if (client != null) {
            client.shutdown(0, 1, TimeUnit.SECONDS);
        }
    }

    /**
     * Durable, shared idempotency: duplicates are detected across restarts and instances, and the claim is atomic (one Lua step), so
     * two instances that receive the same event at the same moment cannot both run its handler while the first holds its lease.
     * Keys and values are the ones the Node runtime writes (a completion is "1", a lease is "p:&lt;owner&gt;"), so Java and Node consumers of
     * one group share the same records. Connects on first use; a Redis failure is an exception, never "not seen".
     */
    public static final class Idempotency implements com.pso.dispatch.IdempotencyStore, AutoCloseable {
        private static final String CLAIM = "local v = redis.call('GET', KEYS[1]) if v == '1' then return 2 end if v and v ~= ARGV[1] then return 0 end "
            + "redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1";
        private static final String RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end return 0";
        private static final String COMPLETE = "local v = redis.call('GET', KEYS[1]) if v and v ~= '1' and v ~= ARGV[1] then return 0 end "
            + "redis.call('SET', KEYS[1], '1', 'PX', ARGV[2]) return 1";
        private static final String RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

        private long script(String script, String key, String owner, long millis) {
            byte[] a = ("p:" + owner).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            byte[] b = String.valueOf(Math.max(1, millis)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            Long r = redis().sync().eval(script, io.lettuce.core.ScriptOutputType.INTEGER, new String[] {prefix + key}, a, b);
            return r == null ? 0 : r;
        }

        @Override
        public Claim claim(String key, String owner, long leaseMillis) {
            long r = script(CLAIM, key, owner, leaseMillis);
            return r == 2 ? Claim.DONE : r == 1 ? Claim.CLAIMED : Claim.BUSY;
        }

        @Override
        public boolean renew(String key, String owner, long leaseMillis) {
            return script(RENEW, key, owner, leaseMillis) == 1;
        }

        @Override
        public boolean complete(String key, String owner, long ttlMillis) {
            return script(COMPLETE, key, owner, ttlMillis) == 1;
        }

        @Override
        public void release(String key, String owner) {
            script(RELEASE, key, owner, 1);
        }

        private final String url;
        private final String prefix;
        private RedisClient client;
        private StatefulRedisConnection<String, byte[]> redis;

        public Idempotency(String url, String prefix) {
            this.url = url;
            this.prefix = prefix;
        }

        private synchronized StatefulRedisConnection<String, byte[]> redis() {
            if (redis == null) {
                try {
                    client = RedisClient.create(url);
                    redis = client.connect(CODEC);
                } catch (RuntimeException e) {
                    throw new DispatchException("PSO_DISPATCH_CONNECT", "cannot connect to Redis for idempotency (" + e.getClass().getSimpleName() + ")");
                }
            }
            return redis;
        }

        @Override
        public boolean has(String key) {
            return redis().sync().exists(prefix + key) == 1;
        }

        @Override
        public void add(String key, long ttlMillis) {
            redis().sync().set(prefix + key, new byte[] {'1'}, io.lettuce.core.SetArgs.Builder.px(ttlMillis));
        }

        @Override
        public synchronized void close() {
            if (redis != null) {
                redis.close();
                client.shutdown(0, 1, TimeUnit.SECONDS);
                redis = null;
            }
        }
    }
}
