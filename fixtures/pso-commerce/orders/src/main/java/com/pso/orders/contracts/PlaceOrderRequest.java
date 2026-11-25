package com.pso.orders.contracts;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

public record PlaceOrderRequest(@NotBlank String customerId, @NotBlank String productId, @Min(1) @Max(1000) int quantity) {
}
