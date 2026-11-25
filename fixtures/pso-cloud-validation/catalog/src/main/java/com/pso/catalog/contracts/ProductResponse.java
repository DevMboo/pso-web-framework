package com.pso.catalog.contracts;

import java.util.UUID;

public record ProductResponse(UUID id, String sku, String name, long priceCents, int stock, String description) {
}
