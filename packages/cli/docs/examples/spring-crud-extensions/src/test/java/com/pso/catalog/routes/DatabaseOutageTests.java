package com.pso.catalog.routes;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pso.test.PsoTestJwt;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/** What the API answers while the database is down, and that it recovers on its own is NOT tested here: the embedded server is stopped for good. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@DirtiesContext
class DatabaseOutageTests {

    private static final PsoTestJwt JWT = new PsoTestJwt();

    @Autowired MockMvc mvc;
    @Autowired EmbeddedPostgres postgres;

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

    @Test
    void whenTheDatabaseIsDownTheApiAnswersWithAProblemAndNeverExposesTheCause() throws Exception {
        String token = "Bearer " + JWT.token("user-1", List.of("products:read", "products:write"), List.of());
        assertEquals(200, mvc.perform(get("/catalog/products").header("Authorization", token)).andReturn().getResponse().getStatus());
        postgres.close();

        long started = System.nanoTime();
        MvcResult read = mvc.perform(get("/catalog/products").header("Authorization", token)).andReturn();
        MvcResult write = mvc.perform(post("/catalog/products").header("Authorization", token).contentType(MediaType.APPLICATION_JSON)
            .content("{\"sku\":\"DB-100\",\"name\":\"Down\",\"priceCents\":100}")).andReturn();
        long millis = (System.nanoTime() - started) / 1_000_000;

        String text = "### read while the database is down\nstatus " + read.getResponse().getStatus() + "\n" + read.getResponse().getContentAsString()
            + "\n\n### write while the database is down\nstatus " + write.getResponse().getStatus() + "\n" + write.getResponse().getContentAsString()
            + "\n\n### both calls took (ms)\n" + millis + "\n";
        Files.writeString(Path.of("target", "outage-transcript.txt"), text);
        assertEquals(500, read.getResponse().getStatus());
        assertEquals(500, write.getResponse().getStatus());
        String body = read.getResponse().getContentAsString();
        assertTrue(!body.contains("jdbc") && !body.contains("postgres") && !body.contains("Connection"), "the cause must not leak to the client");
    }
}
