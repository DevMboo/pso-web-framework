package com.pso.catalog.persistence;

import com.pso.catalog.domain.Product;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.repository.Repository;

/** Read-only queries added by the extension. Spring Data derives the SQL from the method name; every value is a bound parameter. */
public interface ProductQueries extends Repository<Product, UUID> {

    Page<Product> findByNameContainingIgnoreCase(String name, Pageable pageable);
}
