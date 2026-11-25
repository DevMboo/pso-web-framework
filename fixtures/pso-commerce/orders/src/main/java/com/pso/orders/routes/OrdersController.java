package com.pso.orders.routes;

import com.pso.orders.application.OrderService;
import com.pso.orders.contracts.OrderStatusRequest;
import com.pso.orders.contracts.OrdersDto;
import com.pso.orders.contracts.PlaceOrderRequest;
import com.pso.spring.autoconfigure.RepeatsServicePrefix;
import jakarta.validation.Valid;
import java.security.Principal;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

// Served at /orders/orders: the service prefix /orders plus this mapping (the resource is named like the service).
@RestController
@RepeatsServicePrefix
@RequestMapping("/orders")
@RequiredArgsConstructor
public class OrdersController {

    private final OrderService orders;

    @PreAuthorize("hasAuthority('SCOPE_orders:read')")
    @GetMapping
    public List<OrdersDto> list(@RequestParam(required = false) String customerId) {
        return orders.list(customerId);
    }

    @PreAuthorize("hasAuthority('SCOPE_orders:read')")
    @GetMapping("/{id}")
    public OrdersDto get(@PathVariable String id) {
        return orders.get(id);
    }

    @PreAuthorize("hasAuthority('SCOPE_orders:write')")
    @PostMapping
    public OrdersDto place(@Valid @RequestBody PlaceOrderRequest body, Principal caller) {
        return orders.place(body, caller.getName());
    }

    @PreAuthorize("hasAuthority('SCOPE_orders:write')")
    @PatchMapping("/{id}/status")
    public OrdersDto status(@PathVariable String id, @Valid @RequestBody OrderStatusRequest body) {
        return orders.setStatus(id, body.status());
    }
}
