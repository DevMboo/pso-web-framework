package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.it.app.TestApp;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Cross-runtime conformance: the SAME pre-signed tokens as the TypeScript verifier (fixtures/contracts/jwt/cases.json, throwaway key, public JWK only)
 * must be accepted or rejected exactly as recorded, by a real Spring Boot application validating against a real JWKS endpoint.
 */
class JwtConformanceTests {

    static JsonNode fixture() throws Exception {
        for (Path p : List.of(Path.of("../../fixtures/contracts/jwt/cases.json"), Path.of("../fixtures/contracts/jwt/cases.json"))) {
            if (Files.exists(p)) {
                return new ObjectMapper().readTree(Files.readString(p));
            }
        }
        throw new AssertionError("fixtures/contracts/jwt/cases.json not found from " + Path.of("").toAbsolutePath());
    }

    @Test
    void everyTokenOfTheSharedFixtureGetsTheRecordedVerdict() throws Exception {
        JsonNode f = fixture();
        assertThat(f.get("cases").size()).isGreaterThanOrEqualTo(16);
        byte[] jwks = new ObjectMapper().writeValueAsString(f.get("jwks")).getBytes(StandardCharsets.UTF_8);
        HttpServer idp = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        idp.createContext("/jwks", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(200, jwks.length);
            ex.getResponseBody().write(jwks);
            ex.close();
        });
        idp.start();
        List<String> props = new ArrayList<>(List.of("server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "pso.service.name=users-service",
            "pso.limits.requests.per-minute=100000", "pso.dispatch.enabled=false", "pso.security.jwt.algorithms=ES256",
            "pso.security.jwt.jwks-uri=http://127.0.0.1:" + idp.getAddress().getPort() + "/jwks",
            "pso.security.jwt.issuer=" + f.get("issuer").asText(), "pso.security.jwt.audience=" + f.get("audience").asText()));
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(TestApp.class).properties(props.toArray(new String[0])).run()) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            List<String> wrong = new ArrayList<>();
            for (JsonNode c : f.get("cases")) {
                int status = Http.get(port, "/users/customers/1", c.get("token").asText()).statusCode();
                boolean authenticated = status == 200;
                if (authenticated != c.get("authenticated").asBoolean()) {
                    wrong.add(c.get("name").asText() + " -> HTTP " + status);
                }
            }
            assertThat(wrong).as("tokens that the Spring starter judged differently from the recorded (TypeScript-verified) verdict").isEmpty();
            assertThat(Http.get(port, "/users/customers/1", null).statusCode()).as("no token at all").isEqualTo(401);
        } finally {
            idp.stop(0);
        }
    }
}
