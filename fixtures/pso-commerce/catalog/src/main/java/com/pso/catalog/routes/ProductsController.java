package com.pso.catalog.routes;

import com.pso.catalog.application.ProductService;
import com.pso.catalog.contracts.ProductRequest;
import com.pso.catalog.contracts.ProductsDto;
import com.pso.catalog.contracts.StockRequest;
import jakarta.validation.Valid;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/products")
@RequiredArgsConstructor
public class ProductsController {

    private final ProductService products;

    @PreAuthorize("hasAuthority('SCOPE_catalog:read')")
    @GetMapping
    public List<ProductsDto> list() {
        return products.list();
    }

    @PreAuthorize("hasAuthority('SCOPE_catalog:read')")
    @GetMapping("/{id}")
    public ProductsDto get(@PathVariable String id) {
        return products.get(id);
    }

    @PreAuthorize("hasAuthority('SCOPE_catalog:write')")
    @PostMapping
    public ProductsDto create(@Valid @RequestBody ProductRequest body) {
        return products.create(body);
    }

    @PreAuthorize("hasAuthority('SCOPE_catalog:write')")
    @PutMapping("/{id}")
    public ProductsDto update(@PathVariable String id, @Valid @RequestBody ProductRequest body) {
        return products.update(id, body);
    }

    @PreAuthorize("hasAuthority('SCOPE_catalog:write')")
    @PatchMapping("/{id}/stock")
    public ProductsDto stock(@PathVariable String id, @Valid @RequestBody StockRequest body) {
        return products.setStock(id, body.stock());
    }
}
