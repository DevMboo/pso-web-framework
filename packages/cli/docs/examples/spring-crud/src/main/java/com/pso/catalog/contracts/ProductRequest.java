package com.pso.catalog.contracts;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/**
 * What a client may send. The sku is part of the create request only: it identifies the product and cannot be changed afterwards,
 * so the update request leaves it out (an unknown "sku" in an update is ignored by Jackson's defaults in Spring Boot, never applied).
 */
public record ProductRequest(
        @NotBlank @Pattern(regexp = "[A-Z0-9-]{3,32}", message = "must be 3-32 characters: A-Z, 0-9 or -") String sku,
        @NotBlank @Size(max = 120) String name,
        @Positive long priceCents) {
}
