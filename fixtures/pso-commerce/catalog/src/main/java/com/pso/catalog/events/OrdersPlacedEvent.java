package com.pso.catalog.events;

/**
 * Payload of the PSO Dispatch event "orders.placed" (version 1, channel "orders.events"): a DISTRIBUTED event, delivered at least once
 * through the configured broker to every service that declares it. Its contract is the schema in src/main/resources/dispatch/catalog.events.json:
 * keep this record and that schema in step, and declare a new version instead of changing a published one.
 *
 * This service only CONSUMES the event (publish: false).
 */
public record OrdersPlacedEvent(String orderId, String productId, long quantity) {
}
