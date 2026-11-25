package com.pso.catalog.events;

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import com.pso.catalog.application.ProductService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * Consumer of the PSO Dispatch event "orders.placed" (declared in src/main/resources/dispatch/catalog.events.json): a DISTRIBUTED event that arrives through the
 * configured broker, possibly more than once and possibly from another service. Delivery is at least once: make the work
 * idempotent (ctx.envelope().id() identifies the event). An exception triggers the configured retries, then the dead letter channel.
 * It is not a Spring @EventListener: local application events are a different mechanism (`pso make:listener`).
 */
@Component
@RequiredArgsConstructor
public class OrdersPlacedHandler {

    private final ProductService products;

    @PsoEventHandler("orders.placed")
    public void on(OrdersPlacedEvent event, ConsumeContext ctx) {
        products.applyOrder(event.orderId(), event.productId(), event.quantity());
    }
}
