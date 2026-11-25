package com.pso.catalog.contracts;

import java.time.Instant;
import java.util.UUID;

/** The public contract. Internal columns (version) are deliberately absent. */
public record ProductResponse(UUID id, String sku, String name, long priceCents, Instant createdAt, Instant updatedAt) {
}
