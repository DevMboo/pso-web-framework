package com.pso.catalog.routes;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class ProductControllerTests {

    @Autowired
    MockMvc mvc;

    @Test
    @WithMockUser
    void authorizedRequestSucceeds() throws Exception {
        mvc.perform(get("/catalog/catalog/products")).andExpect(status().isOk());
    }

    @Test
    void anonymousRequestIsRejected() throws Exception {
        mvc.perform(get("/catalog/catalog/products")).andExpect(status().isUnauthorized());
    }

}
