package com.pso.orders.contracts;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record OrderRequest(@NotNull UUID customerId, @NotNull UUID productId, @Min(1) int quantity) {
}
