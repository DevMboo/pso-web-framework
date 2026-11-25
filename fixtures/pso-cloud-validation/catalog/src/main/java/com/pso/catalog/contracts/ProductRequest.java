package com.pso.catalog.contracts;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ProductRequest(@NotBlank @Size(max = 32) String sku, @NotBlank @Size(max = 120) String name, @Min(1) long priceCents, @Min(0) int stock, @Size(max = 500) String description) {
}
