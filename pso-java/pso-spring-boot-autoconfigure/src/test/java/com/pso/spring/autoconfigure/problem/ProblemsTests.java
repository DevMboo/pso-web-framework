package com.pso.spring.autoconfigure.problem;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The Java catalog is exactly the language-neutral fixture shared with the TypeScript runtime. */
class ProblemsTests {

    private static JsonNode fixture() throws Exception {
        for (Path p : List.of(Path.of("../../fixtures/contracts/problem/catalog.json"), Path.of("../fixtures/contracts/problem/catalog.json"))) {
            if (Files.exists(p)) {
                return new ObjectMapper().readTree(Files.readString(p));
            }
        }
        throw new AssertionError("fixtures/contracts/problem/catalog.json not found from " + Path.of("").toAbsolutePath());
    }

    @Test
    void catalogEqualsTheSharedFixtureInContentAndOrder() throws Exception {
        JsonNode kinds = fixture().get("kinds");
        assertThat(Problems.CATALOG).hasSize(kinds.size());
        for (int i = 0; i < kinds.size(); i++) {
            JsonNode k = kinds.get(i);
            Problems.Kind j = Problems.CATALOG.get(i);
            assertThat(List.of(j.legacy(), String.valueOf(j.status()), j.code(), j.slug(), j.title(), j.detail()))
                .as("kind #" + i + " (" + k.get("legacy").asText() + ")")
                .containsExactly(k.get("legacy").asText(), k.get("status").asText(), k.get("code").asText(), k.get("slug").asText(), k.get("title").asText(), k.get("detail").asText());
        }
    }

    @Test
    void bodyHasTheDocumentedMembersInOrderAndNeverCarriesTheQueryString() {
        Map<String, Object> b = Problems.body("validation_failed", 400, "c-1", "/orders/42?token=secret",
            List.of(new Problems.FieldProblem("email", "must be an e-mail"), new Problems.FieldProblem(null, "body is required")), null);
        assertThat(new ArrayList<>(b.keySet())).containsExactly("type", "title", "status", "detail", "instance", "code", "correlationId", "errors", "error");
        assertThat(b.get("instance")).isEqualTo("/orders/42");
        assertThat(b.get("type")).isEqualTo("urn:pso:problem:validation-failed");
        assertThat(b.toString()).doesNotContain("secret");
    }

    @Test
    void anApplicationRaisedStatusKeepsItsOwnStatusAndMessage() {
        Map<String, Object> b = Problems.body("teapot_brewing", 418, "c-2", "/tea", null, null);
        assertThat(b).containsEntry("status", 418).containsEntry("code", "PSO_HTTP_ERROR_418").containsEntry("type", "urn:pso:problem:http-418").containsEntry("detail", "teapot_brewing");
    }
}
