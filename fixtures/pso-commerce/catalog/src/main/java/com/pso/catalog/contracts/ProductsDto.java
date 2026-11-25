package com.pso.catalog.contracts;

/** A product as the API returns it. available is derived from the stock. */
public record ProductsDto(String id, String sku, String name, long priceCents, int stock, boolean available) {
}
