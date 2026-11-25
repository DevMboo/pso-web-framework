package com.pso.customers.persistence;

import com.pso.customers.contracts.CustomerResponse;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class CustomerRepository {

    private final JdbcTemplate jdbc;

    public CustomerRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public CustomerResponse insert(String name, String email) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO customers (id, name, email) VALUES (?, ?, ?)", id, name, email);
        return new CustomerResponse(id, name, email);
    }

    public Optional<CustomerResponse> find(UUID id) {
        return jdbc.query("SELECT id, name, email FROM customers WHERE id = ?", (rs, i) -> new CustomerResponse(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("email")), id).stream().findFirst();
    }
}
