package com.pso.customers.application;

import com.pso.customers.contracts.CustomerRequest;
import com.pso.customers.contracts.CustomerResponse;
import com.pso.customers.persistence.CustomerRepository;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class CustomerService {

    private final CustomerRepository customers;

    public CustomerService(CustomerRepository customers) {
        this.customers = customers;
    }

    public CustomerResponse register(CustomerRequest request) {
        try {
            return customers.insert(request.name().trim(), request.email().trim().toLowerCase());
        } catch (DuplicateKeyException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "a customer with this email already exists");
        }
    }

    public CustomerResponse get(UUID id) {
        return customers.find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }
}
