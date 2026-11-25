package com.pso.catalog.application;

import com.pso.catalog.adapters.ProductMapper;
import com.pso.catalog.contracts.ProductRequest;
import com.pso.catalog.contracts.ProductResponse;
import com.pso.catalog.contracts.ProductUpdate;
import com.pso.catalog.domain.Product;
import com.pso.catalog.persistence.ProductRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The transaction boundary. Each public method is one unit of work: either every change commits, or none does.
 * Reads are marked readOnly so the connection can skip dirty checking.
 */
@Service
public class ProductService {

    private final ProductRepository products;
    private final ProductMapper mapper;

    public ProductService(ProductRepository products, ProductMapper mapper) {
        this.products = products;
        this.mapper = mapper;
    }

    @Transactional
    public ProductResponse create(ProductRequest request) {
        if (products.existsBySku(request.sku())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "a product with this sku already exists");
        }
        return mapper.toResponse(products.save(mapper.toEntity(request)));
    }

    @Transactional(readOnly = true)
    public List<ProductResponse> list() {
        return products.findAll().stream().map(mapper::toResponse).toList();
    }

    @Transactional(readOnly = true)
    public ProductResponse get(UUID id) {
        return mapper.toResponse(find(id));
    }

    @Transactional
    public ProductResponse update(UUID id, ProductUpdate update) {
        Product product = find(id);
        product.change(update.name().strip(), update.priceCents()); // dirty checking writes the UPDATE when the transaction commits
        return mapper.toResponse(product);
    }

    @Transactional
    public void delete(UUID id) {
        products.delete(find(id));
    }

    private Product find(UUID id) {
        return products.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }
}
