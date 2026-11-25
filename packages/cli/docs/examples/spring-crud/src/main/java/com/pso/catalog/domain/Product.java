package com.pso.catalog.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/** Persistence model. It is never returned from a controller: the API contract is ProductResponse. */
@Entity
@Table(name = "products")
public class Product {

    @Id
    private UUID id;

    @Column(nullable = false, length = 32, updatable = false)
    private String sku;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(name = "price_cents", nullable = false)
    private long priceCents;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected Product() {
        // required by JPA
    }

    public Product(String sku, String name, long priceCents) {
        this.id = UUID.randomUUID();
        this.sku = sku;
        this.name = name;
        this.priceCents = priceCents;
        this.createdAt = Instant.now();
        this.updatedAt = this.createdAt;
    }

    public void change(String name, long priceCents) {
        this.name = name;
        this.priceCents = priceCents;
        this.updatedAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public String getSku() {
        return sku;
    }

    public String getName() {
        return name;
    }

    public long getPriceCents() {
        return priceCents;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
