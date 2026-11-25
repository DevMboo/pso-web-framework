package com.pso.catalog.contracts;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Request and response contract. Jakarta Validation runs because the controller declares @Valid; a violation becomes a 400 problem+json with field errors. */
public record ProductDto(@NotBlank @Size(max = 64) String id, @NotBlank @Size(max = 120) String name) {
}
