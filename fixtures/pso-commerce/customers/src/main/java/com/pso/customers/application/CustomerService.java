package com.pso.customers.application;

import com.pso.customers.contracts.CustomerRequest;
import com.pso.customers.contracts.CustomersDto;
import com.pso.customers.domain.Customer;
import com.pso.customers.persistence.CustomerRepository;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class CustomerService {

    private final CustomerRepository customers;

    private static CustomersDto view(Customer c) {
        return new CustomersDto(c.getId(), c.getName(), c.getEmail(), c.getStatus());
    }

    @Transactional(readOnly = true)
    public List<CustomersDto> list() {
        return customers.findAll().stream().map(CustomerService::view).toList();
    }

    @Transactional(readOnly = true)
    public CustomersDto get(String id) {
        return view(require(id));
    }

    @Transactional
    public CustomersDto create(CustomerRequest request) {
        if (customers.existsByEmailIgnoreCase(request.email())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "email already registered");
        }
        Customer c = new Customer();
        c.setId(UUID.randomUUID().toString());
        c.setName(request.name());
        c.setEmail(request.email());
        c.setStatus("ACTIVE");
        return view(customers.save(c));
    }

    @Transactional
    public CustomersDto update(String id, CustomerRequest request) {
        Customer c = require(id);
        if (customers.existsByEmailIgnoreCaseAndIdNot(request.email(), id)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "email already registered");
        }
        c.setName(request.name());
        c.setEmail(request.email());
        return view(c);
    }

    @Transactional
    public CustomersDto setStatus(String id, String status) {
        Customer c = require(id);
        c.setStatus(status);
        return view(c);
    }

    private Customer require(String id) {
        return customers.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "customer not found"));
    }
}
