package com.pso.catalog.persistence;

import com.pso.catalog.contracts.ProductResponse;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class ProductRepository {

    private final JdbcTemplate jdbc;

    public ProductRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public ProductResponse insert(String sku, String name, long priceCents, int stock, String description) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO products (id, sku, name, price_cents, stock, description) VALUES (?, ?, ?, ?, ?, ?)", id, sku, name, priceCents, stock, description);
        return new ProductResponse(id, sku, name, priceCents, stock, description);
    }

    public Optional<ProductResponse> find(UUID id) {
        return jdbc.query("SELECT id, sku, name, price_cents, stock, description FROM products WHERE id = ?",
            (rs, i) -> new ProductResponse(rs.getObject("id", UUID.class), rs.getString("sku"), rs.getString("name"), rs.getLong("price_cents"), rs.getInt("stock"), rs.getString("description")), id).stream().findFirst();
    }

    /** Records the decision for an order exactly once; returns false when this order was already decided (a repeated delivery). */
    public boolean recordReservation(String orderId, UUID productId, int quantity, String status) {
        return jdbc.update("INSERT INTO reservations (order_id, product_id, quantity, status) VALUES (?, ?, ?, ?) ON CONFLICT (order_id) DO NOTHING", orderId, productId, quantity, status) == 1;
    }

    /** Takes stock only when enough is left: the condition is part of the UPDATE, so two concurrent orders cannot oversell. */
    public boolean takeStock(UUID productId, int quantity) {
        return jdbc.update("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", quantity, productId, quantity) == 1;
    }
}
