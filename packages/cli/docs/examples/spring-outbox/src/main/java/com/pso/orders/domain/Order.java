package com.pso.orders.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** Persistence model of an order. The id is chosen by the caller, so it is known before the insert and can go into the event. */
@Entity
@Table(name = "orders")
public class Order {

    @Id
    private String id;

    @Column(name = "total_cents", nullable = false)
    private long totalCents;

    protected Order() {
        // required by JPA
    }

    public Order(String id, long totalCents) {
        this.id = id;
        this.totalCents = totalCents;
    }

    public String getId() {
        return id;
    }

    public long getTotalCents() {
        return totalCents;
    }
}
