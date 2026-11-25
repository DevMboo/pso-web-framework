package com.pso.catalog.routes;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class CartItemControllerTests {

    @Autowired
    MockMvc mvc;

    @Test
    @WithMockUser(authorities = {"SCOPE_cart:write"})
    void authorizedRequestSucceeds() throws Exception {
        mvc.perform(post("/catalog/catalog/cart-items").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"1\",\"name\":\"x\"}")).andExpect(status().isOk());
    }

    @Test
    @WithMockUser(authorities = {"SCOPE_cart:write"})
    void blankFieldsAreRejected() throws Exception {
        mvc.perform(post("/catalog/catalog/cart-items").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"\",\"name\":\"\"}")).andExpect(status().isBadRequest());
    }

    @Test
    @WithMockUser(authorities = "SCOPE_unrelated")
    void missingScopeIsForbidden() throws Exception {
        mvc.perform(post("/catalog/catalog/cart-items").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"1\",\"name\":\"x\"}")).andExpect(status().isForbidden());
    }

    @Test
    void anonymousRequestIsRejected() throws Exception {
        mvc.perform(post("/catalog/catalog/cart-items").contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isUnauthorized());
    }

}
