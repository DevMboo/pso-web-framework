package com.pso.spring.channels;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pso.dispatch.DispatchException;
import com.pso.dispatch.PsoDispatch;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import com.pso.spring.autoconfigure.web.CorrelationIdFilter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Publishes through PSO Dispatch: the channel event is the payload of the declared Dispatch event (default {@code channels.publish}), whose
 * envelope carries this service's authenticated name as {@code source}. The orchestrator checks that source against the channel's
 * {@code publishers} allow-list. Nothing here talks to a browser or knows an orchestrator address.
 */
public final class DispatchChannelPublisher implements PsoChannelPublisher {

    private static final Logger LOG = LoggerFactory.getLogger(DispatchChannelPublisher.class);
    private static final Pattern CHANNEL = Pattern.compile("^[a-z][a-z0-9_-]{0,63}(\\.[A-Za-z0-9_-]{1,64}){0,7}$");
    private static final Pattern EVENT = Pattern.compile("^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$");
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_.:-]{8,100}$");
    private static final Pattern CORRELATION = Pattern.compile("^[A-Za-z0-9._-]{8,64}$");

    private final PsoDispatch dispatch;
    private final Supplier<Outbox> outbox;
    private final String service;
    private final String dispatchEvent;
    private final long maxPayloadBytes;
    private final ObjectMapper mapper;
    private final AtomicLong sent = new AtomicLong(), stored = new AtomicLong(), scheduled = new AtomicLong(), failedAfterCommit = new AtomicLong(), rejected = new AtomicLong();

    /** @param outbox yields the outbox bean, or null when {@code pso.dispatch.outbox.enabled} is off (looked up per call so start-up order never matters) */
    public DispatchChannelPublisher(PsoDispatch dispatch, Supplier<Outbox> outbox, String service, String dispatchEvent, long maxPayloadBytes, ObjectMapper mapper) {
        this.dispatch = dispatch;
        this.outbox = outbox;
        this.service = service;
        this.dispatchEvent = dispatchEvent;
        this.maxPayloadBytes = maxPayloadBytes;
        this.mapper = mapper;
    }

    @Override
    public Outcome publish(String channel, String eventType, Object payload, Options options) {
        Options o = options == null ? Options.bestEffort() : options;
        ObjectNode message = build(channel, eventType, payload, o);
        String id = message.get("id").asText();
        String correlation = message.has("correlationId") ? message.get("correlationId").asText() : null;
        PsoDispatch.PublishInput input = new PsoDispatch.PublishInput(correlation, null, channel, id, 0);
        boolean tx = TransactionSynchronizationManager.isActualTransactionActive();
        if (o.delivery() == Delivery.DURABLE) {
            Outbox box = outbox.get();
            if (!tx) {
                rejected.incrementAndGet();
                throw new ChannelPublishException("PSO_CHANNEL_DURABLE_UNAVAILABLE", "durable delivery needs an active transaction: call it from a @Transactional method (the event is stored together with your data). Use Delivery.BEST_EFFORT for an ephemeral notification.");
            }
            if (box == null) {
                rejected.incrementAndGet();
                throw new ChannelPublishException("PSO_CHANNEL_DURABLE_UNAVAILABLE", "durable delivery needs the transactional outbox: set pso.dispatch.outbox.enabled=true (see `pso dispatch:outbox`). The event was NOT downgraded to best effort.");
            }
            try {
                box.publish(dispatchEvent, message, input);
            } catch (DispatchException e) {
                rejected.incrementAndGet();
                throw new ChannelPublishException("PSO_CHANNEL_TRANSPORT", "the outbox refused the event (" + e.code() + ")", e);
            }
            stored.incrementAndGet();
            return new Outcome(id, Delivery.DURABLE, Status.STORED_IN_OUTBOX, "stored in the outbox in the caller's transaction; relayed to Dispatch at least once");
        }
        if (tx && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    try {
                        send(message, input);
                    } catch (RuntimeException e) {
                        failedAfterCommit.incrementAndGet();
                        LOG.error("best-effort channel event {} on {} could not be sent after commit and is lost: {}", id, channel, e.getMessage());
                    }
                }
            });
            scheduled.incrementAndGet();
            return new Outcome(id, Delivery.BEST_EFFORT, Status.SCHEDULED_AFTER_COMMIT, "will be sent after the transaction commits; not sent on rollback; lost if the transport fails afterwards");
        }
        com.pso.dispatch.DispatchAdapter.PublishResult r = send(message, input);
        return new Outcome(id, Delivery.BEST_EFFORT, Status.SENT, r.acknowledgement());
    }

    private com.pso.dispatch.DispatchAdapter.PublishResult send(ObjectNode message, PsoDispatch.PublishInput input) {
        try {
            com.pso.dispatch.DispatchAdapter.PublishResult r = dispatch.publish(dispatchEvent, message, input);
            sent.incrementAndGet();
            return r;
        } catch (DispatchException e) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_TRANSPORT", "Dispatch refused the channel event (" + e.code() + "): is the \"" + dispatchEvent + "\" event declared (dispatch/*.events.json) and the provider enabled?", e);
        }
    }

    private ObjectNode build(String channel, String eventType, Object payload, Options o) {
        if (channel == null || !CHANNEL.matcher(channel).matches()) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_INVALID_CHANNEL", "the channel must be a concrete name such as candidate.c1 (lower-case first segment, then [A-Za-z0-9_-] segments): patterns and placeholders are not publishable");
        }
        if (eventType == null || eventType.length() > 100 || !EVENT.matcher(eventType).matches()) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_INVALID_EVENT", "the event type must be dotted lower-case, for example candidate.updated");
        }
        if (o.eventId() != null && !ID.matcher(o.eventId()).matches()) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_INVALID_EVENT", "the event id must be 8-100 characters of [A-Za-z0-9_.:-]");
        }
        String correlation = o.correlationId() != null ? o.correlationId() : MDC.get(CorrelationIdFilter.MDC_KEY);
        JsonNode body;
        try {
            body = mapper.valueToTree(payload);
        } catch (IllegalArgumentException e) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_INVALID_PAYLOAD", "the payload cannot be serialized to JSON", e);
        }
        if (body == null || !body.isObject()) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_INVALID_PAYLOAD", "the payload must serialize to a JSON object (use a record or bean as the event contract)");
        }
        if (body.toString().getBytes(StandardCharsets.UTF_8).length > maxPayloadBytes) {
            rejected.incrementAndGet();
            throw new ChannelPublishException("PSO_CHANNEL_PAYLOAD_TOO_LARGE", "the payload exceeds pso.channels.max-payload (" + maxPayloadBytes + " bytes)");
        }
        ObjectNode m = mapper.createObjectNode();
        m.put("v", 1);
        m.put("id", o.eventId() != null ? o.eventId() : UUID.randomUUID().toString());
        m.put("type", eventType);
        m.put("channel", channel);
        m.put("ts", Instant.now().toString());
        if (correlation != null && CORRELATION.matcher(correlation).matches()) {
            m.put("correlationId", correlation);
        }
        m.put("source", service);
        m.set("payload", body);
        return m;
    }

    @Override
    public Metrics metrics() {
        return new Metrics(sent.get(), stored.get(), scheduled.get(), failedAfterCommit.get(), rejected.get());
    }
}
