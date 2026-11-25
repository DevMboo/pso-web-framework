package com.pso.orders.contracts;

import java.util.UUID;

public record OrderResponse(UUID id, UUID customerId, UUID productId, int quantity, String status) {
}
