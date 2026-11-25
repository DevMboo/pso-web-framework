package com.pso.catalog.routes;

import com.pso.catalog.contracts.ProductDto;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.pso.spring.autoconfigure.RepeatsServicePrefix;

// The service prefix /catalog is applied by PSO, so this resource is served at /catalog/catalog/products. The path repeats the prefix on
// purpose (the resource is named like the service): @RepeatsServicePrefix says so, otherwise PSO would refuse it as a mistake.
@RestController
@RepeatsServicePrefix
@RequestMapping("/catalog/products")
public class ProductController {

    @GetMapping
    public List<ProductDto> list() {
        return List.of(new ProductDto("p-1", "Espresso beans"), new ProductDto("p-2", "Pour-over kettle"));
    }
}
