package com.pso.customers.contracts;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

public record CustomerStatusRequest(@NotNull @Pattern(regexp = "ACTIVE|SUSPENDED") String status) {
}
