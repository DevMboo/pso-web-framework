package com.pso.orders.application;

import com.pso.orders.contracts.OrderRequest;
import com.pso.orders.contracts.OrderResponse;
import com.pso.orders.persistence.OrderRepository;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import com.pso.spring.channels.PsoChannelPublisher;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** The order and its event are ONE unit of work (transactional outbox); the final status and its notification are too (durable channel event). */
@Service
public class OrderService {

    private final OrderRepository orders;
    private final Outbox outbox;
    private final PsoChannelPublisher channels;

    public OrderService(OrderRepository orders, Outbox outbox, PsoChannelPublisher channels) {
        this.orders = orders;
        this.outbox = outbox;
        this.channels = channels;
    }

    @Transactional
    public OrderResponse place(OrderRequest r) {
        OrderResponse order = orders.insert(r.customerId(), r.productId(), r.quantity());
        outbox.publish("orders.created", Map.of("orderId", order.id().toString(), "customerId", r.customerId().toString(), "productId", r.productId().toString(), "quantity", r.quantity()));
        return order;
    }

    public OrderResponse get(UUID id) {
        return orders.find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    @Transactional
    public void inventoryDecided(UUID orderId, boolean reserved) {
        String status = reserved ? "CONFIRMED" : "REJECTED";
        if (!orders.decide(orderId, status)) {
            return; // already decided: a duplicate delivery has no effect and sends no second notification
        }
        channels.publish("order." + orderId, "order.updated", Map.of("orderId", orderId.toString(), "status", status), PsoChannelPublisher.Options.durable());
    }
}
