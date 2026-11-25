package com.pso.customers.routes;

import com.pso.customers.application.CustomerService;
import com.pso.customers.contracts.CustomerRequest;
import com.pso.customers.contracts.CustomerStatusRequest;
import com.pso.customers.contracts.CustomersDto;
import com.pso.spring.autoconfigure.RepeatsServicePrefix;
import jakarta.validation.Valid;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// Served at /customers/customers: the service prefix /customers plus this mapping (the resource is named like the service).
@RestController
@RepeatsServicePrefix
@RequestMapping("/customers")
@RequiredArgsConstructor
public class CustomersController {

    private final CustomerService customers;

    @PreAuthorize("hasAuthority('SCOPE_customers:read')")
    @GetMapping
    public List<CustomersDto> list() {
        return customers.list();
    }

    @PreAuthorize("hasAuthority('SCOPE_customers:read')")
    @GetMapping("/{id}")
    public CustomersDto get(@PathVariable String id) {
        return customers.get(id);
    }

    @PreAuthorize("hasAuthority('SCOPE_customers:write')")
    @PostMapping
    public CustomersDto create(@Valid @RequestBody CustomerRequest body) {
        return customers.create(body);
    }

    @PreAuthorize("hasAuthority('SCOPE_customers:write')")
    @PutMapping("/{id}")
    public CustomersDto update(@PathVariable String id, @Valid @RequestBody CustomerRequest body) {
        return customers.update(id, body);
    }

    @PreAuthorize("hasAuthority('SCOPE_customers:write')")
    @PatchMapping("/{id}/status")
    public CustomersDto status(@PathVariable String id, @Valid @RequestBody CustomerStatusRequest body) {
        return customers.setStatus(id, body.status());
    }
}
