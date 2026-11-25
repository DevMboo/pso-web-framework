package com.pso.orders.persistence;

import com.pso.orders.domain.Order;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data generates the implementation. */
public interface OrderRepository extends JpaRepository<Order, String> {
}
