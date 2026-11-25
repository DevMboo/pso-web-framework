package com.pso.spring.autoconfigure.dispatch;

import com.pso.dispatch.PsoDispatch;
import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.binder.MeterBinder;
import java.util.function.ToDoubleFunction;

/**
 * Publishes the dispatch runtime's counters (and the outbox relay's, when present) as Micrometer meters, so they reach OpenTelemetry through
 * the registry the application already has. Only real counters are bound; the broker's health is a 1/0 gauge of the adapter's own probe.
 * Consumer lag and dead-letter depth are NOT bound: the runtime does not measure them.
 */
public final class PsoDispatchMetrics implements MeterBinder {

    private final PsoDispatch dispatch;
    private final Outbox outbox;

    public PsoDispatchMetrics(PsoDispatch dispatch, Outbox outbox) {
        this.dispatch = dispatch;
        this.outbox = outbox;
    }

    private static void counter(MeterRegistry r, String name, String description, PsoDispatch d, ToDoubleFunction<PsoDispatch.Metrics> f) {
        FunctionCounter.builder(name, d, x -> f.applyAsDouble(x.metrics())).description(description).register(r);
    }

    @Override
    public void bindTo(MeterRegistry r) {
        counter(r, "pso.dispatch.published", "Events published", dispatch, PsoDispatch.Metrics::published);
        counter(r, "pso.dispatch.publish.failures", "Failed publications", dispatch, PsoDispatch.Metrics::publishFailed);
        counter(r, "pso.dispatch.consumed", "Events handled successfully", dispatch, PsoDispatch.Metrics::consumed);
        counter(r, "pso.dispatch.handler.failures", "Handler failures", dispatch, PsoDispatch.Metrics::failed);
        counter(r, "pso.dispatch.retries", "Retry attempts", dispatch, PsoDispatch.Metrics::retried);
        counter(r, "pso.dispatch.dead.lettered", "Events moved to the dead-letter channel", dispatch, PsoDispatch.Metrics::deadLettered);
        counter(r, "pso.dispatch.duplicates", "Duplicate deliveries suppressed", dispatch, PsoDispatch.Metrics::duplicates);
        counter(r, "pso.dispatch.poison", "Poison messages", dispatch, PsoDispatch.Metrics::poison);
        FunctionCounter.builder("pso.dispatch.processing.time", dispatch, d -> d.metrics().processingTotalMillis()).baseUnit("milliseconds").description("Total handler time").register(r);
        Gauge.builder("pso.dispatch.processing.max", dispatch, d -> d.metrics().processingMaxMillis()).baseUnit("milliseconds").register(r);
        Gauge.builder("pso.dispatch.broker.up", dispatch, d -> {
            try {
                return d.health().up() ? 1 : 0;
            } catch (RuntimeException e) {
                return 0;
            }
        }).description("1 when the adapter's own health probe answers up").register(r);
        if (outbox != null) {
            FunctionCounter.builder("pso.outbox.relayed", outbox, Outbox::relayed).description("Outbox events published to the broker").register(r);
            FunctionCounter.builder("pso.outbox.failures", outbox, Outbox::failures).description("Outbox relay attempts that failed").register(r);
            FunctionCounter.builder("pso.outbox.gave.up", outbox, Outbox::gaveUp).description("Outbox events marked failed after the maximum attempts").register(r);
        }
    }
}
