package com.pso.orders.contracts;

/** An order as the API returns it. Amounts are integer cents. */
public record OrdersDto(String id, String customerId, String productId, int quantity, long unitPriceCents, long totalCents, String status, String createdBy) {
}
