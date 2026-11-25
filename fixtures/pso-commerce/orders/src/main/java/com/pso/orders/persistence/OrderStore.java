package com.pso.orders.persistence;

import com.pso.orders.contracts.OrdersDto;
import com.pso.orders.events.OrdersPlacedEvent;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** The orders table. An order and the event that announces it are written in ONE transaction (transactional outbox). */
@Component
@RequiredArgsConstructor
public class OrderStore {

    private static final RowMapper<OrdersDto> ROW = (rs, n) -> new OrdersDto(rs.getString("id"), rs.getString("customer_id"), rs.getString("product_id"),
        rs.getInt("quantity"), rs.getLong("unit_price_cents"), rs.getLong("total_cents"), rs.getString("status"), rs.getString("created_by"));

    private final JdbcTemplate jdbc;
    private final Outbox outbox;

    @Transactional
    public void insert(OrdersDto o) {
        jdbc.update("INSERT INTO orders (id, customer_id, product_id, quantity, unit_price_cents, total_cents, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            o.id(), o.customerId(), o.productId(), o.quantity(), o.unitPriceCents(), o.totalCents(), o.status(), o.createdBy());
        outbox.publish("orders.placed", new OrdersPlacedEvent(o.id(), o.productId(), o.quantity()));
    }

    public Optional<OrdersDto> find(String id) {
        return jdbc.query("SELECT * FROM orders WHERE id = ?", ROW, id).stream().findFirst();
    }

    public List<OrdersDto> list(String customerId) {
        return customerId == null
            ? jdbc.query("SELECT * FROM orders ORDER BY created_at", ROW)
            : jdbc.query("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at", ROW, customerId);
    }

    @Transactional
    public boolean setStatus(String id, String status) {
        return jdbc.update("UPDATE orders SET status = ? WHERE id = ?", status, id) == 1;
    }
}
