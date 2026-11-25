package com.pso.orders.contracts;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

public record OrderStatusRequest(@NotNull @Pattern(regexp = "CONFIRMED|CANCELLED") String status) {
}
