package com.pso.catalog.application;

import com.pso.catalog.adapters.ProductMapper;
import com.pso.catalog.contracts.PagedProducts;
import com.pso.catalog.contracts.ProductPatch;
import com.pso.catalog.contracts.ProductResponse;
import com.pso.catalog.domain.Product;
import com.pso.catalog.persistence.ProductQueries;
import com.pso.catalog.persistence.ProductRepository;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Search with pagination, filtering and an allow-listed sort, and a partial update. Each public method is one transaction. */
@Service
public class ProductCatalogService {

    /** The only sort keys a client may use, mapped to entity properties. An open "sort" parameter would let clients probe any column. */
    private static final Map<String, String> SORTABLE = Map.of("name", "name", "price", "priceCents", "created", "createdAt");
    static final int MAX_PAGE_SIZE = 50;

    private final ProductQueries queries;
    private final ProductRepository products;
    private final ProductMapper mapper;

    public ProductCatalogService(ProductQueries queries, ProductRepository products, ProductMapper mapper) {
        this.queries = queries;
        this.products = products;
        this.mapper = mapper;
    }

    @Transactional(readOnly = true)
    public PagedProducts search(String name, int page, int size, String sort, String direction) {
        if (page < 0 || size < 1 || size > MAX_PAGE_SIZE) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "page must be >= 0 and size between 1 and " + MAX_PAGE_SIZE);
        }
        String property = SORTABLE.get(sort);
        if (property == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "sort must be one of " + SORTABLE.keySet().stream().sorted().toList());
        }
        Sort.Direction dir = "desc".equalsIgnoreCase(direction) ? Sort.Direction.DESC : Sort.Direction.ASC;
        Page<Product> result = queries.findByNameContainingIgnoreCase(name == null ? "" : name.strip(), PageRequest.of(page, size, Sort.by(dir, property)));
        return new PagedProducts(result.map(mapper::toResponse).getContent(), result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages());
    }

    @Transactional
    public ProductResponse patch(UUID id, ProductPatch patch) {
        Product product = products.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        product.change(patch.name() != null ? patch.name().strip() : product.getName(), patch.priceCents() != null ? patch.priceCents() : product.getPriceCents());
        return mapper.toResponse(product); // dirty checking writes one UPDATE at commit
    }
}
