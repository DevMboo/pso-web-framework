package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.it.app.TestApp;
import java.net.http.HttpRequest;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

/** Correlation id handling and the liveness body, against the same shared fixture the TypeScript orchestrator executes. */
@SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service", "pso.limits.requests.per-minute=100000"})
class ConformanceHttpTests extends Base {

    static JsonNode fixture() throws Exception {
        Path file = List.of(Path.of("../../fixtures/contracts/conformance/http.json"), Path.of("../fixtures/contracts/conformance/http.json")).stream().filter(Files::exists).findFirst()
            .orElseThrow(() -> new AssertionError("fixtures/contracts/conformance/http.json not found from " + Path.of("").toAbsolutePath()));
        return new ObjectMapper().readTree(Files.readString(file));
    }

    @Test
    void correlationIdHandlingMatchesTheSharedFixture() throws Exception {
        JsonNode corr = fixture().get("correlation");
        String header = corr.get("header").asText();
        for (JsonNode c : corr.get("cases")) {
            HttpRequest.Builder b = Http.req(port, "/actuator/health", null);
            if (!c.get("incoming").isNull()) {
                b.header(header, c.get("incoming").asText());
            }
            var r = Http.send(b.GET());
            String got = r.headers().firstValue(header).orElse("");
            assertThat(got).as(c.get("name").asText()).isNotEmpty().matches("[A-Za-z0-9._-]{8,64}");
            if (c.get("propagated").asBoolean()) {
                assertThat(got).as(c.get("name").asText()).isEqualTo(c.get("incoming").asText());
            } else {
                assertThat(got).as(c.get("name").asText()).isNotEqualTo(c.get("incoming").isNull() ? null : c.get("incoming").asText());
            }
        }
    }

    @Test
    void livenessBodyMatchesTheSharedFixture() throws Exception {
        JsonNode live = fixture().get("liveness");
        var r = Http.get(port, "/actuator/health", null);
        assertThat(r.statusCode()).isEqualTo(live.get("http").asInt());
        assertThat(new ObjectMapper().readTree(r.body()).get("status").asText()).isEqualTo(live.get("status").asText());
    }
}
