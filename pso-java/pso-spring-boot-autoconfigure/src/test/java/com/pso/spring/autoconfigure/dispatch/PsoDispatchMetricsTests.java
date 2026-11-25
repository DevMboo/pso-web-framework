package com.pso.spring.autoconfigure.dispatch;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.PsoDispatch;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class PsoDispatchMetricsTests {

    @Test
    void realCountersAndTheBrokerHealthAreBoundAsMeters() {
        AtomicBoolean up = new AtomicBoolean(true);
        PsoDispatch dispatch = new PsoDispatch() {
            @Override public com.pso.dispatch.DispatchAdapter.PublishResult publish(String type, Object payload, PublishInput in) { throw new UnsupportedOperationException(); }
            @Override public DispatchAdapter.Health health() { return new DispatchAdapter.Health(up.get(), "probe"); }
            @Override public Metrics metrics() { return new Metrics(7, 1, 5, 2, 3, 1, 0, 4, 1, 5, 500, 200); }
        };
        SimpleMeterRegistry r = new SimpleMeterRegistry();
        new PsoDispatchMetrics(dispatch, null).bindTo(r);
        assertThat(r.get("pso.dispatch.published").functionCounter().count()).isEqualTo(7);
        assertThat(r.get("pso.dispatch.consumed").functionCounter().count()).isEqualTo(5);
        assertThat(r.get("pso.dispatch.retries").functionCounter().count()).isEqualTo(3);
        assertThat(r.get("pso.dispatch.dead.lettered").functionCounter().count()).isEqualTo(1);
        assertThat(r.get("pso.dispatch.broker.up").gauge().value()).isEqualTo(1);
        up.set(false);
        assertThat(r.get("pso.dispatch.broker.up").gauge().value()).isEqualTo(0);
        assertThat(r.find("pso.outbox.relayed").meter()).as("no outbox, no outbox meters (not zeros)").isNull();
        assertThat(r.find("pso.dispatch.lag").meter()).as("lag is not measured, so it is not invented").isNull();
    }
}
