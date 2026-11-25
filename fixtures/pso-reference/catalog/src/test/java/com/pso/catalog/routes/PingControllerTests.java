package com.pso.catalog.routes;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.pso.test.PsoTestJwt;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/** Real JWT validation: tokens are signed with a real key and verified against a real (loopback) JWKS endpoint. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class PingControllerTests {

    private static final PsoTestJwt JWT = new PsoTestJwt();
    private static final String PATH = "/catalog/ping";
    private static final String BODY = "{\"message\":\"hello\"}";

    @Autowired
    MockMvc mvc;

    @DynamicPropertySource
    static void jwt(DynamicPropertyRegistry r) {
        r.add("pso.security.jwt.jwks-uri", JWT::jwksUri);
        r.add("pso.security.jwt.issuer", () -> PsoTestJwt.ISSUER);
        r.add("pso.security.jwt.audience", () -> PsoTestJwt.AUDIENCE);
        r.add("pso.security.jwt.algorithms", () -> "ES256");
    }

    @AfterAll
    static void stop() {
        JWT.close();
    }

    private String token(String... scopes) {
        return "Bearer " + JWT.token("user-1", List.of(scopes), List.of());
    }

    @Test
    void aValidTokenWithTheScopeSucceeds() throws Exception {
        mvc.perform(post(PATH).header("Authorization", token("ping:write")).contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.service").value("catalog"))
            .andExpect(jsonPath("$.message").value("hello"));
    }

    @Test
    void aTokenWithoutTheScopeIsForbidden() throws Exception {
        mvc.perform(post(PATH).header("Authorization", token("other")).contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isForbidden());
    }

    @Test
    void noTokenIsUnauthorized() throws Exception {
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON).content(BODY)).andExpect(status().isUnauthorized());
    }

    @Test
    void anExpiredTokenIsUnauthorized() throws Exception {
        String expired = "Bearer " + JWT.token(PsoTestJwt.ISSUER, PsoTestJwt.AUDIENCE, "u", List.of("ping:write"), List.of(), Instant.now().minusSeconds(3600));
        mvc.perform(post(PATH).header("Authorization", expired).contentType(MediaType.APPLICATION_JSON).content(BODY)).andExpect(status().isUnauthorized());
    }

    @Test
    void invalidBodiesAreRejectedWithFieldErrors() throws Exception {
        mvc.perform(post(PATH).header("Authorization", token("ping:write")).contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"\"}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.fields.message").exists());
    }

    @Test
    void theUnprefixedPathDoesNotExist() throws Exception {
        mvc.perform(post("/ping").header("Authorization", token("ping:write")).contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isNotFound());
    }
}
