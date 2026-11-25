package com.pso.catalog.application;

import com.pso.catalog.persistence.ProductRepository;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Decides an order against the stock. Everything below is ONE transaction: the decision row, the stock change and the outbox event
 * commit together or not at all. A repeated delivery of the same order finds its decision row and changes nothing (idempotent).
 */
@Service
public class InventoryService {

    private final ProductRepository products;
    private final Outbox outbox;

    public InventoryService(ProductRepository products, Outbox outbox) {
        this.products = products;
        this.outbox = outbox;
    }

    @Transactional
    public void decide(String orderId, String productId, int quantity) {
        UUID product = UUID.fromString(productId);
        boolean enough = products.find(product).map(p -> p.stock() >= quantity).orElse(false);
        boolean fresh = products.recordReservation(orderId, product, quantity, enough ? "RESERVED" : "REJECTED");
        if (!fresh) {
            return; // already decided: a duplicate delivery has no business effect
        }
        boolean taken = enough && products.takeStock(product, quantity);
        if (enough && !taken) { // lost a race with another order between the check and the update
            throw new IllegalStateException("stock changed concurrently; the delivery is retried");
        }
        outbox.publish(taken ? "inventory.reserved" : "inventory.rejected", Map.of("orderId", orderId, "productId", productId, "quantity", quantity));
    }
}
