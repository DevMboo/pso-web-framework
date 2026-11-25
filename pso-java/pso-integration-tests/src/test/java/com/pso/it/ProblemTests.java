package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.it.app.TestApp;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The PSO error standard (RFC 9457) end to end in a real Spring Boot application with real HTTP and real JWT validation. Every response is
 * checked against the language-neutral fixture shared with the TypeScript orchestrator (fixtures/contracts/problem/catalog.json).
 */
@SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "pso.service.name=users-service", "pso.limits.requests.per-minute=100000"})
class ProblemTests extends Base {

    static final ObjectMapper MAPPER = new ObjectMapper();

    static JsonNode fixtureKind(String legacy) throws Exception {
        for (Path p : List.of(Path.of("../../fixtures/contracts/problem/catalog.json"), Path.of("../fixtures/contracts/problem/catalog.json"), Path.of("fixtures/contracts/problem/catalog.json"))) {
            if (Files.exists(p)) {
                for (JsonNode k : MAPPER.readTree(Files.readString(p)).get("kinds")) {
                    if (k.get("legacy").asText().equals(legacy)) {
                        return k;
                    }
                }
            }
        }
        throw new AssertionError("fixture kind not found: " + legacy);
    }

    /** Asserts the response is a PSO problem identical in contract to the fixture and returns it. */
    JsonNode expect(HttpResponse<String> r, String legacy) throws Exception {
        JsonNode k = fixtureKind(legacy);
        assertThat(r.statusCode()).as(legacy).isEqualTo(k.get("status").asInt());
        assertThat(r.headers().firstValue("content-type").orElse("")).startsWith("application/problem+json");
        JsonNode p = MAPPER.readTree(r.body());
        assertThat(p.get("type").asText()).isEqualTo("urn:pso:problem:" + k.get("slug").asText());
        assertThat(p.get("title").asText()).isEqualTo(k.get("title").asText());
        assertThat(p.get("status").asInt()).isEqualTo(k.get("status").asInt());
        assertThat(p.get("detail").asText()).isEqualTo(k.get("detail").asText());
        assertThat(p.get("code").asText()).isEqualTo(k.get("code").asText());
        assertThat(p.get("error").asText()).as("deprecated legacy member").isEqualTo(legacy);
        assertThat(p.get("correlationId").asText()).isNotBlank();
        assertThat(r.headers().firstValue("x-correlation-id").orElse("")).as("header and body agree").isEqualTo(p.get("correlationId").asText());
        List<String> members = new ArrayList<>();
        p.fieldNames().forEachRemaining(members::add);
        assertThat(members).as("member order").startsWith("type", "title", "status", "detail");
        assertThat(r.body()).doesNotContain("hunter2", "/etc/passwd", "secret-token-123", "jdbc:", "Exception", "\tat ");
        return p;
    }

    HttpResponse<String> post(String path, String contentType, String body, String token) {
        return Http.send(Http.req(port, path, token).header("Content-Type", contentType).POST(HttpRequest.BodyPublishers.ofString(body)));
    }

    @Test
    void validationFailureListsFieldsAndKeepsTheLegacyShape() throws Exception {
        JsonNode p = expect(post("/users/probe/validate", "application/json", "{\"name\":\"\",\"email\":\"nope\"}", token()), "validation_failed");
        List<String> fields = new ArrayList<>();
        p.get("errors").forEach(e -> fields.add(e.get("field").asText()));
        assertThat(fields).containsExactlyInAnyOrder("name", "email");
        assertThat(p.get("fields").get("name").asText()).as("deprecated map kept for clients of the former template handler").isNotBlank();
        assertThat(p.get("instance").asText()).isEqualTo("/users/probe/validate");
    }

    @Test
    void malformedJsonIs400WithoutEchoingTheParserMessage() throws Exception {
        expect(post("/users/probe/validate", "application/json", "{not json", token()), "invalid_json");
    }

    @Test
    void unknownPathMethodNotAllowedAndUnsupportedMediaType() throws Exception {
        JsonNode nf = expect(Http.get(port, "/users/probe/does-not-exist?token=secret", token()), "not_found");
        assertThat(nf.get("instance").asText()).as("no query string").isEqualTo("/users/probe/does-not-exist");
        HttpResponse<String> m = Http.get(port, "/users/probe/validate", token());
        expect(m, "method_not_allowed");
        assertThat(m.headers().firstValue("allow")).as("the Allow header survives").isPresent();
        expect(post("/users/customers", "text/plain", "x", token()), "unsupported_media_type");
        expect(Http.get(port, "/users/probe/typed/abc", token()), "bad_request");
    }

    @Test
    void anApplicationRaisedProblemCarriesItsCatalogKindAndItsOwnSafeDetail() throws Exception {
        HttpResponse<String> r = Http.get(port, "/users/probe/conflict", token());
        assertThat(r.statusCode()).isEqualTo(409);
        assertThat(r.headers().firstValue("content-type").orElse("")).startsWith("application/problem+json");
        JsonNode p = MAPPER.readTree(r.body());
        JsonNode k = fixtureKind("conflict");
        assertThat(p.get("type").asText()).isEqualTo("urn:pso:problem:" + k.get("slug").asText());
        assertThat(p.get("code").asText()).isEqualTo("PSO_HTTP_CONFLICT");
        assertThat(p.get("title").asText()).isEqualTo(k.get("title").asText());
        assertThat(p.get("detail").asText()).isEqualTo("A product with SKU ABC-1 already exists");
    }

    @Test
    void unexpectedExceptionsAreAGeneric500ThatLeaksNothing() throws Exception {
        expect(Http.get(port, "/users/probe/boom", token()), "internal_error");
    }

    @Test
    void httpClientFailuresMapExactlyLikeTheOrchestrator() throws Exception {
        expect(Http.get(port, "/users/probe/upstream/TIMEOUT", token()), "upstream_timeout");
        expect(Http.get(port, "/users/probe/upstream/CONNECT", token()), "upstream_unavailable");
        expect(Http.get(port, "/users/probe/upstream/POLICY", token()), "upstream_policy");
        expect(Http.get(port, "/users/probe/upstream/RESPONSE_TOO_LARGE", token()), "upstream_response_too_large");
        expect(Http.get(port, "/users/probe/upstream/TLS", token()), "upstream_tls");
    }

    /**
     * F-22: an answer of a remote service is not a gateway failure. 404 and 409 keep their status (as upstream_not_found /
     * upstream_conflict), any other 4xx is "the remote refused what this service asked" (502 upstream_rejected, not bad_gateway's
     * "invalid response"), a 5xx stays 502 bad_gateway. The remote body and the exception message are never part of the answer.
     */
    @Test
    void anAnswerOfARemoteServiceIsMappedByItsMeaningAndNeverEchoed() throws Exception {
        for (var c : List.of(Map.entry(404, "upstream_not_found"), Map.entry(409, "upstream_conflict"), Map.entry(400, "upstream_rejected"),
            Map.entry(401, "upstream_rejected"), Map.entry(403, "upstream_rejected"), Map.entry(422, "upstream_rejected"), Map.entry(500, "bad_gateway"), Map.entry(503, "bad_gateway"))) {
            HttpResponse<String> r = Http.get(port, "/users/probe/upstream-status/" + c.getKey(), token());
            JsonNode p = expect(r, c.getValue());
            assertThat(r.body()).as("status %s", c.getKey()).doesNotContain("secret-token-123").doesNotContain("remote said");
            assertThat(r.headers().firstValue("www-authenticate")).as("a remote 401 is not this caller's 401").isEmpty();
            assertThat(p.get("instance").asText()).isEqualTo("/users/probe/upstream-status/" + c.getKey());
        }
        assertThat(Http.get(port, "/users/probe/upstream-status/404", token()).statusCode()).isEqualTo(404);
        assertThat(Http.get(port, "/users/probe/upstream-status/409", token()).statusCode()).isEqualTo(409);
        assertThat(Http.get(port, "/users/probe/upstream-status/400", token()).statusCode()).isEqualTo(502);
        assertThat(Http.get(port, "/users/probe/upstream-status/500", token()).statusCode()).isEqualTo(502);
    }

    @Test
    void anApplicationCanTranslateARemoteAnswerOnPurpose() throws Exception {
        HttpResponse<String> r = Http.get(port, "/users/probe/upstream-translated", token());
        assertThat(r.statusCode()).isEqualTo(422);
        assertThat(r.body()).contains("unknown customer").doesNotContain("customers answered");
    }

    @Test
    void authenticationAndAuthorizationFailuresFromTheFilterChainAreProblemsToo() throws Exception {
        HttpResponse<String> unauth = Http.get(port, "/users/customers/1", null);
        JsonNode p = expect(unauth, "unauthorized");
        assertThat(unauth.headers().firstValue("www-authenticate").orElse("")).startsWith("Bearer");
        assertThat(p.get("instance").asText()).isEqualTo("/users/customers/1");
        assertThat(Http.get(port, "/users/customers/1", "not.a.jwt").body()).contains("PSO_AUTH_UNAUTHORIZED");
        expect(Http.send(Http.req(port, "/users/customers/1", token("customers:read")).DELETE()), "forbidden");
    }
}
