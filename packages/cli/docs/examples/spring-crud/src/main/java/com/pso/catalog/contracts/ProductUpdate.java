package com.pso.catalog.contracts;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/** The fields a client may change on an existing product. */
public record ProductUpdate(@NotBlank @Size(max = 120) String name, @Positive long priceCents) {
}
