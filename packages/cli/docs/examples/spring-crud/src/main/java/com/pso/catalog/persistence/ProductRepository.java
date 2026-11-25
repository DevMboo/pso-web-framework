package com.pso.catalog.persistence;

import com.pso.catalog.domain.Product;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data generates the implementation. Derived queries are parameterised: values are never concatenated into SQL. */
public interface ProductRepository extends JpaRepository<Product, UUID> {

    boolean existsBySku(String sku);
}
