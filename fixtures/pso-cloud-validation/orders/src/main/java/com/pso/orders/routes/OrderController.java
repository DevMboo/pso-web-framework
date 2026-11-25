package com.pso.orders.routes;

import com.pso.orders.application.OrderService;
import com.pso.orders.contracts.OrderRequest;
import com.pso.orders.contracts.OrderResponse;
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
@RequestMapping("/orders")
public class OrderController {

    private final OrderService service;

    public OrderController(OrderService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    @PreAuthorize("hasAuthority('SCOPE_orders:write')")
    public OrderResponse place(@Valid @RequestBody OrderRequest request) {
        return service.place(request);
    }

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_orders:read')")
    public OrderResponse get(@PathVariable UUID id) {
        return service.get(id);
    }
}
