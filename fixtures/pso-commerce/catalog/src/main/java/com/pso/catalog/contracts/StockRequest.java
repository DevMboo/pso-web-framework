package com.pso.catalog.contracts;

import jakarta.validation.constraints.Min;

public record StockRequest(@Min(0) int stock) {
}
