package com.pso.orders.persistence;

import com.pso.orders.contracts.OrderResponse;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {

    private final JdbcTemplate jdbc;

    public OrderRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public OrderResponse insert(UUID customerId, UUID productId, int quantity) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO orders (id, customer_id, product_id, quantity, status) VALUES (?, ?, ?, ?, 'PENDING')", id, customerId, productId, quantity);
        return new OrderResponse(id, customerId, productId, quantity, "PENDING");
    }

    public Optional<OrderResponse> find(UUID id) {
        return jdbc.query("SELECT id, customer_id, product_id, quantity, status FROM orders WHERE id = ?",
            (rs, i) -> new OrderResponse(rs.getObject("id", UUID.class), rs.getObject("customer_id", UUID.class), rs.getObject("product_id", UUID.class), rs.getInt("quantity"), rs.getString("status")), id).stream().findFirst();
    }

    /** Moves a PENDING order to its final status; false when it was already decided (a repeated delivery). */
    public boolean decide(UUID id, String status) {
        return jdbc.update("UPDATE orders SET status = ?, updated_at = now() WHERE id = ? AND status = 'PENDING'", status, id) == 1;
    }
}
