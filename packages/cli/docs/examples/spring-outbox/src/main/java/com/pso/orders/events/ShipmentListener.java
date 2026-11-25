package com.pso.orders.events;

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * The consumer. Delivery is at least once, so the handler must be safe to run twice for the same event: the primary key of
 * shipments.order_id turns a second delivery into a no-op.
 */
@Component
public class ShipmentListener {

    public record OrderCreated(String orderId) {
    }

    private final JdbcTemplate jdbc;

    public ShipmentListener(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PsoEventHandler("orders.created")
    public void on(OrderCreated event, ConsumeContext ctx) {
        jdbc.update("INSERT INTO shipments (order_id) VALUES (?) ON CONFLICT (order_id) DO NOTHING", event.orderId());
    }
}
