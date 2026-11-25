package com.pso.catalog.application;

import com.pso.catalog.contracts.ProductRequest;
import com.pso.catalog.contracts.ProductResponse;
import com.pso.catalog.persistence.ProductRepository;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProductService {

    private final ProductRepository products;

    public ProductService(ProductRepository products) {
        this.products = products;
    }

    public ProductResponse create(ProductRequest r) {
        try {
            return products.insert(r.sku().trim(), r.name().trim(), r.priceCents(), r.stock(), r.description());
        } catch (DuplicateKeyException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "a product with this sku already exists");
        }
    }

    public ProductResponse get(UUID id) {
        return products.find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }
}
