package com.pso.catalog.routes;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.catalog.domain.Product;
import com.pso.catalog.persistence.ProductRepository;
import com.pso.test.PsoTestJwt;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Pagination, filtering, sorting, PATCH and optimistic locking against a real PostgreSQL. Each exchange is also written to target/extensions-transcript.txt. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@org.springframework.context.annotation.Import(ProductExtensionsTests.LockDemoController.class)
class ProductExtensionsTests {

    private static final PsoTestJwt JWT = new PsoTestJwt();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final StringBuilder TRANSCRIPT = new StringBuilder();

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ProductRepository products;
    @Autowired PlatformTransactionManager tx;

    @DynamicPropertySource
    static void jwt(DynamicPropertyRegistry r) {
        r.add("pso.security.jwt.jwks-uri", JWT::jwksUri);
        r.add("pso.security.jwt.issuer", () -> PsoTestJwt.ISSUER);
        r.add("pso.security.jwt.audience", () -> PsoTestJwt.AUDIENCE);
        r.add("pso.security.jwt.algorithms", () -> "ES256");
    }

    @AfterAll
    static void stop() throws Exception {
        JWT.close();
        Path out = Path.of("target", "extensions-transcript.txt");
        Files.createDirectories(out.getParent());
        Files.writeString(out, TRANSCRIPT.toString());
    }

    /** A controller that only exists in tests: it raises the exception a lost optimistic-lock race produces, to see what PSO answers. */
    @RestController
    @RequestMapping("/lock-demo")
    public static class LockDemoController {
        @GetMapping
        public String conflict() {
            throw new org.springframework.orm.ObjectOptimisticLockingFailureException(Product.class, "demo");
        }
    }

    private static String bearer(String... scopes) {
        return "Bearer " + JWT.token("user-1", List.of(scopes), List.of());
    }

    private String record(String label, org.springframework.test.web.servlet.MvcResult r) throws Exception {
        String body = r.getResponse().getContentAsString();
        TRANSCRIPT.append("### ").append(label).append("\nstatus ").append(r.getResponse().getStatus()).append("\n").append(body).append("\n\n");
        return body;
    }

    private JsonNode create(String sku, String name, long price) throws Exception {
        String body = mvc.perform(post("/catalog/products").header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sku\":\"" + sku + "\",\"name\":\"" + name + "\",\"priceCents\":" + price + "}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        return JSON.readTree(body);
    }

    @Test
    void searchPaginatesFiltersAndSorts() throws Exception {
        jdbc.update("delete from products");
        create("KB-100", "Keyboard", 4999);
        create("KB-200", "Keyboard Pro", 9999);
        create("MS-100", "Mouse", 1999);
        create("MN-100", "Monitor", 15999);
        create("HD-100", "Headset", 8999);

        // page 0 of size 2, cheapest first: the total is the whole table, not the page
        String p0 = record("page 0, size 2, sort price asc", mvc.perform(get("/catalog/products/search?size=2&sort=price&direction=asc").header("Authorization", bearer("products:read")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(2)).andExpect(jsonPath("$.totalElements").value(5)).andExpect(jsonPath("$.totalPages").value(3)).andReturn());
        assertEquals("Mouse", JSON.readTree(p0).at("/items/0/name").asText());
        assertEquals("Keyboard", JSON.readTree(p0).at("/items/1/name").asText());

        // the last page is shorter
        record("page 2, size 2, sort price asc", mvc.perform(get("/catalog/products/search?size=2&page=2&sort=price").header("Authorization", bearer("products:read")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1)).andReturn());

        // filtering is case-insensitive and partial
        record("filter name=keyboard, sort name desc", mvc.perform(get("/catalog/products/search?name=keyboard&sort=name&direction=desc").header("Authorization", bearer("products:read")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.totalElements").value(2)).andExpect(jsonPath("$.items[0].name").value("Keyboard Pro")).andReturn());

        // a filter containing SQL stays a value
        record("filter with SQL metacharacters", mvc.perform(get("/catalog/products/search").param("name", "'; drop table products; --").header("Authorization", bearer("products:read")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.totalElements").value(0)).andReturn());
        assertEquals(5, jdbc.queryForObject("select count(*) from products", Integer.class));

        // bounds and the allow-list
        record("size too large", mvc.perform(get("/catalog/products/search?size=500").header("Authorization", bearer("products:read"))).andExpect(status().isBadRequest()).andReturn());
        record("sort not allowed", mvc.perform(get("/catalog/products/search?sort=sku").header("Authorization", bearer("products:read"))).andExpect(status().isBadRequest()).andReturn());
        record("search without the scope", mvc.perform(get("/catalog/products/search").header("Authorization", bearer("products:write"))).andExpect(status().isForbidden()).andReturn());
    }

    @Test
    void patchChangesOnlyWhatIsSent() throws Exception {
        JsonNode created = create("PT-100", "Patch me", 1000);
        String id = created.get("id").asText();

        String renamed = record("PATCH name only", mvc.perform(patch("/catalog/products/" + id).header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Renamed\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.name").value("Renamed")).andExpect(jsonPath("$.priceCents").value(1000)).andReturn());
        assertEquals("PT-100", JSON.readTree(renamed).get("sku").asText());
        assertEquals(1000L, jdbc.queryForObject("select price_cents from products where id = ?::uuid", Long.class, id));

        record("PATCH price only", mvc.perform(patch("/catalog/products/" + id).header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON).content("{\"priceCents\":2500}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.name").value("Renamed")).andExpect(jsonPath("$.priceCents").value(2500)).andReturn());
        assertEquals(2L, jdbc.queryForObject("select version from products where id = ?::uuid", Long.class, id), "two updates, two version increments");

        record("PATCH with an empty body", mvc.perform(patch("/catalog/products/" + id).header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isBadRequest()).andReturn());
        record("PATCH with an invalid price", mvc.perform(patch("/catalog/products/" + id).header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON).content("{\"priceCents\":-1}"))
            .andExpect(status().isBadRequest()).andReturn());
        record("PATCH of an unknown id", mvc.perform(patch("/catalog/products/00000000-0000-0000-0000-000000000000").header("Authorization", bearer("products:write")).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"x\"}"))
            .andExpect(status().isNotFound()).andReturn());
        record("PATCH without the scope", mvc.perform(patch("/catalog/products/" + id).header("Authorization", bearer("products:read")).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"x\"}"))
            .andExpect(status().isForbidden()).andReturn());
        assertEquals("Renamed", jdbc.queryForObject("select name from products where id = ?::uuid", String.class, id), "rejected patches changed nothing");
    }

    @Test
    void aLostRaceIsDetectedByTheVersionColumn() {
        Product original = products.save(new Product("LK-100", "Lock me", 1000));
        TransactionTemplate t = new TransactionTemplate(tx);

        // transaction A reads version 0, then transaction B commits a change, then A tries to commit its own
        OptimisticLockingFailureException failure = assertThrows(OptimisticLockingFailureException.class, () -> t.executeWithoutResult((a) -> {
            Product inA = products.findById(original.getId()).orElseThrow();
            new TransactionTemplate(tx, definitionRequiringNew()).executeWithoutResult((b) -> products.findById(original.getId()).orElseThrow().change("changed by B", 2000));
            inA.change("changed by A", 3000);
            products.flush();
        }));
        TRANSCRIPT.append("### optimistic lock race (service level)\n").append(failure.getClass().getName()).append("\n\n");
        assertEquals("changed by B", jdbc.queryForObject("select name from products where id = ?", String.class, original.getId()), "the winner is stored, the loser is rejected");
        assertEquals(1L, jdbc.queryForObject("select version from products where id = ?", Long.class, original.getId()));
    }

    @Test
    void anUnmappedLockFailureAnswersWithAProblem() throws Exception {
        var r = mvc.perform(get("/catalog/lock-demo").header("Authorization", bearer("products:read"))).andReturn();
        record("unmapped ObjectOptimisticLockingFailureException", r);
        assertEquals(500, r.getResponse().getStatus(), "PSO does not map a lost optimistic-lock race: it is an internal error unless you add a handler");
    }

    private static org.springframework.transaction.support.DefaultTransactionDefinition definitionRequiringNew() {
        var d = new org.springframework.transaction.support.DefaultTransactionDefinition();
        d.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return d;
    }
}
