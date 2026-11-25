package com.pso.accounts.routes;

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
class UserControllerTests {

    @Autowired
    MockMvc mvc;

    @Test
    @WithMockUser(authorities = {"SCOPE_users:admin"})
    void authorizedRequestSucceeds() throws Exception {
        mvc.perform(get("/accounts/accounts/users")).andExpect(status().isOk());
    }

    @Test
    @WithMockUser(authorities = "SCOPE_unrelated")
    void missingScopeIsForbidden() throws Exception {
        mvc.perform(get("/accounts/accounts/users")).andExpect(status().isForbidden());
    }

    @Test
    void anonymousRequestIsRejected() throws Exception {
        mvc.perform(get("/accounts/accounts/users")).andExpect(status().isUnauthorized());
    }

}
