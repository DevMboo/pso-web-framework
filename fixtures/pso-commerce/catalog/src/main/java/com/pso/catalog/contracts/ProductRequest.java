package com.pso.catalog.contracts;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ProductRequest(@NotBlank @Size(min = 2, max = 40) String sku, @NotBlank @Size(min = 2, max = 120) String name, @Min(0) long priceCents, @Min(0) int stock) {
}
