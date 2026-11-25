package com.pso.orders.events;

/**
 * Payload of the PSO Dispatch event "orders.placed" (version 1, channel "orders.events"): a DISTRIBUTED event, delivered at least once
 * through the configured broker to every service that declares it. Its contract is the schema in src/main/resources/dispatch/orders.events.json:
 * keep this record and that schema in step, and declare a new version instead of changing a published one.
 *
 * Publish it with the injected PsoDispatch (the event must be declared, as it now is):
 *   dispatch.publish("orders.placed", new OrdersPlacedEvent(orderId, productId, quantity));
 * Inside a transaction that also changes data, use the transactional outbox instead (`pso dispatch:outbox`).
 */
public record OrdersPlacedEvent(String orderId, String productId, long quantity) {
}
