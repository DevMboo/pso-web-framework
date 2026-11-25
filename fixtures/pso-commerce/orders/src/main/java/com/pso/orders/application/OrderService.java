package com.pso.orders.application;

import com.pso.orders.contracts.OrdersDto;
import com.pso.orders.contracts.PlaceOrderRequest;
import com.pso.orders.persistence.OrderStore;
import com.pso.spring.http.PsoHttpClient;
import com.pso.spring.http.PsoHttpException;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class OrderService {

    record Customer(String id, String status) {
    }

    record Product(String id, long priceCents, int stock) {
    }

    private final PsoHttpClient http;
    private final OrderStore orders;

    /**
     * The customer and the product belong to other services: they are asked over HTTPS, with the caller's token. The order and
     * its event are then stored in one local transaction. There is no distributed transaction: the stock is reduced when the
     * catalog service consumes the event.
     */
    public OrdersDto place(PlaceOrderRequest request, String author) {
        Customer customer = lookup("customers", "/customers/{id}", Customer.class, request.customerId(), "unknown customer");
        if (!"ACTIVE".equals(customer.status())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "customer is not active");
        }
        Product product = lookup("catalog", "/products/{id}", Product.class, request.productId(), "unknown product");
        if (product.stock() < request.quantity()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "insufficient stock");
        }
        long total = Math.multiplyExact(product.priceCents(), (long) request.quantity());
        OrdersDto order = new OrdersDto(UUID.randomUUID().toString(), customer.id(), product.id(), request.quantity(), product.priceCents(), total, "PLACED", author);
        orders.insert(order);
        return order;
    }

    public OrdersDto get(String id) {
        return orders.find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "order not found"));
    }

    public List<OrdersDto> list(String customerId) {
        return orders.list(customerId);
    }

    public OrdersDto setStatus(String id, String status) {
        if (!orders.setStatus(id, status)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "order not found");
        }
        return get(id);
    }

    private <T> T lookup(String service, String path, Class<T> type, String id, String whenMissing) {
        try {
            return http.get(service, path, type, id);
        } catch (PsoHttpException e) {
            if (e.isStatus(404)) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, whenMissing);
            }
            throw e;
        }
    }
}
