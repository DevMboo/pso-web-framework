package com.pso.catalog.events;

import com.pso.catalog.application.InventoryService;
import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import org.springframework.stereotype.Component;

/** Consumer of events published by the orders service. Delivery is at least once; InventoryService is idempotent by order id. */
@Component
public class OrderEvents {

    public record OrderCreated(String orderId, String customerId, String productId, int quantity) {
    }

    private final InventoryService inventory;

    public OrderEvents(InventoryService inventory) {
        this.inventory = inventory;
    }

    @PsoEventHandler("orders.created")
    public void on(OrderCreated event, ConsumeContext ctx) {
        inventory.decide(event.orderId(), event.productId(), event.quantity());
    }
}
