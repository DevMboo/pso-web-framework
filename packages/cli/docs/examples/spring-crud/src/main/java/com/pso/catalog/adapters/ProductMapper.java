package com.pso.catalog.adapters;

import com.pso.catalog.contracts.ProductRequest;
import com.pso.catalog.contracts.ProductResponse;
import com.pso.catalog.domain.Product;
import org.springframework.stereotype.Component;

/** Hand-written mapping keeps the boundary explicit: every field that crosses it is a decision, not a side effect of reflection. */
@Component
public class ProductMapper {

    public Product toEntity(ProductRequest request) {
        return new Product(request.sku(), request.name().strip(), request.priceCents());
    }

    public ProductResponse toResponse(Product p) {
        return new ProductResponse(p.getId(), p.getSku(), p.getName(), p.getPriceCents(), p.getCreatedAt(), p.getUpdatedAt());
    }
}
