package com.pso.customers.application;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.pso.customers.contracts.PingRequest;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import org.junit.jupiter.api.Test;

class PingServiceTests {

    @Test
    void echoesTheMessageWithTheServiceName() {
        PingService service = new PingService(new PsoServiceInfo("customers", "/customers"));
        var dto = service.ping(PingRequest.builder().message("hello").build());
        assertEquals("customers", dto.service());
        assertEquals("hello", dto.message());
        assertNotNull(dto.at());
    }
}
