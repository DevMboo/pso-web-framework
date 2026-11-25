package com.pso.catalog.contracts;

import java.util.List;

/** One page of products plus what a client needs to ask for the next one. */
public record PagedProducts(List<ProductResponse> items, int page, int size, long totalElements, int totalPages) {
}
