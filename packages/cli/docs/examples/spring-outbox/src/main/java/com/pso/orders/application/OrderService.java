package com.pso.orders.application;

import com.pso.orders.domain.Order;
import com.pso.orders.persistence.OrderRepository;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The transaction boundary. Saving the order and storing the event are ONE unit of work: if either fails, neither is kept.
 * The event is not sent to the broker here; the outbox relay does that after the commit.
 */
@Service
public class OrderService {

    private final OrderRepository orders;
    private final Outbox outbox;

    public OrderService(OrderRepository orders, Outbox outbox) {
        this.orders = orders;
        this.outbox = outbox;
    }

    @Transactional
    public Order create(String id, long totalCents) {
        Order saved = orders.save(new Order(id, totalCents));
        outbox.publish("orders.created", Map.of("orderId", saved.getId())); // an INSERT into pso_outbox, in this transaction
        return saved;
    }

    /** Same work, then a failure after the event was stored: the order and the event must both disappear. */
    @Transactional
    public Order createThenFail(String id, long totalCents) {
        create(id, totalCents);
        throw new IllegalStateException("simulated failure after the event was stored");
    }
}
