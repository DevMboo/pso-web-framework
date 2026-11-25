package com.pso.dispatch;

import com.pso.dispatch.DispatchAdapter.Health;
import com.pso.dispatch.DispatchAdapter.PublishResult;

/** The provider-independent application API: inject it with constructor injection and publish declared events. */
public interface PsoDispatch {

    /** Optional metadata of a publication. All fields are nullable; {@code timeoutMillis} 0 means the transport default. */
    record PublishInput(String correlationId, String causationId, String key, String id, long timeoutMillis) {
        public static PublishInput none() {
            return new PublishInput(null, null, null, null, 0);
        }
    }

    /**
     * Validates the payload against the declared contract and hands the event to the transport. The result's {@code acknowledgement}
     * states exactly what the transport guaranteed when publish returned (see provider capabilities); it never means "consumed".
     */
    PublishResult publish(String type, Object payload, PublishInput input);

    default PublishResult publish(String type, Object payload) {
        return publish(type, payload, PublishInput.none());
    }

    Health health();

    Metrics metrics();

    /** Bounded counters (per event type only for declared types). */
    record Metrics(long published, long publishFailed, long consumed, long failed, long retried, long deadLettered, long dropped, long duplicates, long poison,
                   long processingCount, long processingTotalMillis, long processingMaxMillis) {
    }

    /** What the application gets while dispatch is disabled: a clear error on use, no connection, no background work. */
    final class Disabled implements PsoDispatch {
        @Override
        public PublishResult publish(String type, Object payload, PublishInput input) {
            throw new DispatchException("PSO_DISPATCH_DISABLED", "cannot publish \"" + type + "\": dispatch is disabled (pso.dispatch.enabled=false). Install a provider with `pso dispatch:install` and enable it.");
        }

        @Override
        public Health health() {
            return new Health(false, "dispatch is disabled");
        }

        @Override
        public Metrics metrics() {
            return new Metrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
    }
}
