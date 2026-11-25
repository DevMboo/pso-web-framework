package com.pso.catalog.routes;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.catalog.contracts.ProductRequest;
import com.pso.catalog.application.ProductService;
import com.pso.test.PsoTestJwt;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Real HTTP layer, real JWT validation, real PostgreSQL (embedded), real Flyway migrations. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ProductCrudTests {

    private static final PsoTestJwt JWT = new PsoTestJwt();
    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ProductService service;
    @Autowired PlatformTransactionManager tx;

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

    private static String bearer(String... scopes) {
        return "Bearer " + JWT.token("user-1", List.of(scopes), List.of());
    }

    private JsonNode create(String sku, String name, long price) throws Exception {
        String body = mvc.perform(post("/catalog/products").header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sku\":\"" + sku + "\",\"name\":\"" + name + "\",\"priceCents\":" + price + "}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        return JSON.readTree(body);
    }

    @Test
    void flywayAppliedTheProductsMigration() {
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE version = '1' AND success", Integer.class));
    }

    @Test
    void createReadUpdateDeleteRoundTrip() throws Exception {
        JsonNode created = create("KB-100", "Keyboard", 4999);
        String id = created.get("id").asText();
        assertEquals("KB-100", created.get("sku").asText());
        assertEquals(false, created.has("version"), "internal columns never leave the service");

        mvc.perform(get("/catalog/products/" + id).header("Authorization", bearer("products:read")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.name").value("Keyboard")).andExpect(jsonPath("$.priceCents").value(4999));
        mvc.perform(put("/catalog/products/" + id).header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Mechanical keyboard\",\"priceCents\":5999}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.name").value("Mechanical keyboard")).andExpect(jsonPath("$.sku").value("KB-100"));
        assertEquals(5999L, jdbc.queryForObject("SELECT price_cents FROM products WHERE id = ?::uuid", Long.class, id));
        mvc.perform(delete("/catalog/products/" + id).header("Authorization", bearer("products:write"))).andExpect(status().isNoContent());
        mvc.perform(get("/catalog/products/" + id).header("Authorization", bearer("products:read")))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("PSO_HTTP_NOT_FOUND")).andExpect(jsonPath("$.correlationId").exists());
    }

    @Test
    void invalidInputIsA400ProblemWithFieldErrorsAndNothingIsStored() throws Exception {
        int before = jdbc.queryForObject("SELECT count(*) FROM products", Integer.class);
        mvc.perform(post("/catalog/products").header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sku\":\"bad sku!\",\"name\":\"\",\"priceCents\":-5}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("PSO_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[?(@.field=='sku')]").exists())
            .andExpect(jsonPath("$.errors[?(@.field=='name')]").exists())
            .andExpect(jsonPath("$.errors[?(@.field=='priceCents')]").exists());
        assertEquals(before, jdbc.queryForObject("SELECT count(*) FROM products", Integer.class));
    }

    @Test
    void aDuplicateSkuIsA409AndTheDatabaseConstraintIsTheLastLineOfDefence() throws Exception {
        create("DUP-1", "First", 100);
        mvc.perform(post("/catalog/products").header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sku\":\"DUP-1\",\"name\":\"Second\",\"priceCents\":200}"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.status").value(409)).andExpect(jsonPath("$.code").value("PSO_HTTP_ERROR_409"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM products WHERE sku = 'DUP-1'", Integer.class));
        assertThrows(org.springframework.dao.DuplicateKeyException.class, () -> jdbc.update("INSERT INTO products (id, sku, name, price_cents) VALUES (gen_random_uuid(), 'DUP-1', 'x', 1)"));
    }

    @Test
    void scopesAreEnforcedBeforeAnythingTouchesTheDatabase() throws Exception {
        mvc.perform(get("/catalog/products").header("Authorization", bearer("other"))).andExpect(status().isForbidden());
        mvc.perform(get("/catalog/products")).andExpect(status().isUnauthorized());
        mvc.perform(post("/catalog/products").header("Authorization", bearer("products:read")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sku\":\"NOPE-1\",\"name\":\"n\",\"priceCents\":1}"))
            .andExpect(status().isForbidden());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM products WHERE sku = 'NOPE-1'", Integer.class));
    }

    @Test
    void aFailureInsideATransactionRollsEverythingBack() {
        TransactionTemplate t = new TransactionTemplate(tx);
        assertThrows(IllegalStateException.class, () -> t.executeWithoutResult(status -> {
            service.create(new ProductRequest("ROLL-1", "Rolled back", 100)); // joins this transaction
            throw new IllegalStateException("something after the insert failed");
        }));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM products WHERE sku = 'ROLL-1'", Integer.class), "the insert was rolled back with the rest");
    }
}
