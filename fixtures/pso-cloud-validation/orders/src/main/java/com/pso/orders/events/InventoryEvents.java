package com.pso.orders.events;

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import com.pso.orders.application.OrderService;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
public class InventoryEvents {

    public record Decision(String orderId, String productId, int quantity) {
    }

    private final OrderService orders;

    public InventoryEvents(OrderService orders) {
        this.orders = orders;
    }

    @PsoEventHandler("inventory.reserved")
    public void reserved(Decision d, ConsumeContext ctx) {
        orders.inventoryDecided(UUID.fromString(d.orderId()), true);
    }

    @PsoEventHandler("inventory.rejected")
    public void rejected(Decision d, ConsumeContext ctx) {
        orders.inventoryDecided(UUID.fromString(d.orderId()), false);
    }
}
