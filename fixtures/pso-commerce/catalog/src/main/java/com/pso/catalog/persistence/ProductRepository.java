package com.pso.catalog.persistence;

import com.pso.catalog.domain.Product;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProductRepository extends JpaRepository<Product, String> {

    boolean existsBySku(String sku);
}
