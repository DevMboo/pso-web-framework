package com.pso.catalog.routes;

import com.pso.catalog.contracts.CartItemDto;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.pso.spring.autoconfigure.RepeatsServicePrefix;

// The service prefix /catalog is applied by PSO, so this resource is served at /catalog/catalog/cart-items. The path repeats the prefix on
// purpose (the resource is named like the service): @RepeatsServicePrefix says so, otherwise PSO would refuse it as a mistake.
@RestController
@RepeatsServicePrefix
@RequestMapping("/catalog/cart-items")
public class CartItemController {

    @PreAuthorize("hasAuthority('SCOPE_cart:write')")
    @PostMapping
    public CartItemDto create(@Valid @RequestBody CartItemDto body) {
        return body;
    }
}
