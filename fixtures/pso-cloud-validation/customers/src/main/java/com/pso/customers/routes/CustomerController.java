package com.pso.customers.routes;

import com.pso.customers.application.CustomerService;
import com.pso.customers.contracts.CustomerRequest;
import com.pso.customers.contracts.CustomerResponse;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@com.pso.spring.autoconfigure.RepeatsServicePrefix
@RequestMapping("/customers")
public class CustomerController {

    private final CustomerService service;

    public CustomerController(CustomerService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('SCOPE_customers:write')")
    public CustomerResponse register(@Valid @RequestBody CustomerRequest request) {
        return service.register(request);
    }

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_customers:read')")
    public CustomerResponse get(@PathVariable UUID id) {
        return service.get(id);
    }
}
