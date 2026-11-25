package com.pso.catalog.application;

import com.pso.catalog.contracts.ProductRequest;
import com.pso.catalog.contracts.ProductsDto;
import com.pso.catalog.domain.Product;
import com.pso.catalog.persistence.ProductRepository;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class ProductService {

    private final ProductRepository products;
    private final JdbcTemplate jdbc;

    private static ProductsDto view(Product p) {
        return new ProductsDto(p.getId(), p.getSku(), p.getName(), p.getPriceCents(), p.getStock(), p.getStock() > 0);
    }

    @Transactional(readOnly = true)
    public List<ProductsDto> list() {
        return products.findAll().stream().map(ProductService::view).toList();
    }

    @Transactional(readOnly = true)
    public ProductsDto get(String id) {
        return view(require(id));
    }

    @Transactional
    public ProductsDto create(ProductRequest request) {
        if (products.existsBySku(request.sku())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "sku already exists");
        }
        Product p = new Product();
        p.setId(UUID.randomUUID().toString());
        apply(p, request);
        return view(products.save(p));
    }

    @Transactional
    public ProductsDto update(String id, ProductRequest request) {
        Product p = require(id);
        apply(p, request);
        return view(p);
    }

    @Transactional
    public ProductsDto setStock(String id, int stock) {
        Product p = require(id);
        p.setStock(stock);
        return view(p);
    }

    /** Applies the stock movement of an order exactly once, whatever the number of deliveries of its event. */
    @Transactional
    public boolean applyOrder(String orderId, String productId, long quantity) {
        if (jdbc.update("INSERT INTO applied_orders (order_id) VALUES (?) ON CONFLICT DO NOTHING", orderId) == 0) {
            return false;
        }
        jdbc.update("UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?", quantity, productId);
        return true;
    }

    private static void apply(Product p, ProductRequest r) {
        p.setSku(r.sku());
        p.setName(r.name());
        p.setPriceCents(r.priceCents());
        p.setStock(r.stock());
    }

    private Product require(String id) {
        return products.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "product not found"));
    }
}
