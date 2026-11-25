package com.pso.catalog.routes;

import com.pso.catalog.application.ProductCatalogService;
import com.pso.catalog.contracts.PagedProducts;
import com.pso.catalog.contracts.ProductPatch;
import com.pso.catalog.contracts.ProductResponse;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Extra operations next to ProductController: search (filter, sort, paginate) and PATCH. The service prefix is applied by PSO. */
@RestController
@RequestMapping("/products")
public class ProductExtrasController {

    private final ProductCatalogService service;

    public ProductExtrasController(ProductCatalogService service) {
        this.service = service;
    }

    @GetMapping("/search")
    @PreAuthorize("hasAuthority('SCOPE_products:read')")
    public PagedProducts search(@RequestParam(required = false) String name,
                                @RequestParam(defaultValue = "0") int page,
                                @RequestParam(defaultValue = "10") int size,
                                @RequestParam(defaultValue = "created") String sort,
                                @RequestParam(defaultValue = "asc") String direction) {
        return service.search(name, page, size, sort, direction);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_products:write')")
    public ProductResponse patch(@PathVariable UUID id, @Valid @RequestBody ProductPatch patch) {
        return service.patch(id, patch);
    }
}
