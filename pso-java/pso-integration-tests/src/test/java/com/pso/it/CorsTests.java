package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.it.app.TestApp;
import java.net.http.HttpRequest;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;

class CorsTests {

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000",
        "pso.security.cors.enabled=true",
        "pso.security.cors.allowed-origins[0]=http://localhost:3000", "pso.security.cors.allowed-origins[1]=http://127.0.0.1:3000",
        "pso.security.cors.allowed-origin-patterns[0]=https://*.example.com",
        "pso.security.cors.max-age=30m"})
    class Enabled extends Base {

        private HttpRequest.Builder preflight(String origin, String method) {
            return Http.req(port, "/users/customers/1", null).header("Origin", origin).header("Access-Control-Request-Method", method)
                .header("Access-Control-Request-Headers", "authorization,content-type").method("OPTIONS", HttpRequest.BodyPublishers.noBody());
        }

        @Test
        void preflightFromAnExactAllowedOriginSucceedsWithoutAToken() {
            var r = Http.send(preflight("http://localhost:3000", "GET"));
            assertThat(r.statusCode()).isEqualTo(200);
            assertThat(r.headers().firstValue("Access-Control-Allow-Origin")).contains("http://localhost:3000");
            assertThat(r.headers().firstValue("Access-Control-Max-Age")).contains("1800");
            assertThat(r.headers().firstValue("Access-Control-Allow-Credentials")).as("credentials are off").isEmpty();
        }

        @Test
        void aWildcardSubdomainPatternMatchesOnlyThatDomain() {
            assertThat(Http.send(preflight("https://app.example.com", "GET")).statusCode()).isEqualTo(200);
            assertThat(Http.send(preflight("https://evil.com", "GET")).statusCode()).isEqualTo(403);
            assertThat(Http.send(preflight("https://example.com.evil.com", "GET")).statusCode()).isEqualTo(403);
        }

        @Test
        void aNonListedOriginIsRefusedAndGetsNoCorsHeaders() {
            var pre = Http.send(preflight("http://evil.example", "GET"));
            assertThat(pre.statusCode()).isEqualTo(403);
            assertThat(pre.headers().firstValue("Access-Control-Allow-Origin")).isEmpty();
            var actual = Http.send(Http.req(port, "/users/customers/1", token()).header("Origin", "http://evil.example").GET());
            assertThat(actual.headers().firstValue("Access-Control-Allow-Origin")).isEmpty();
        }

        @Test
        void corsIsNotAuthentication() {
            var r = Http.send(Http.req(port, "/users/customers/1", null).header("Origin", "http://localhost:3000").GET());
            assertThat(r.statusCode()).as("an allowed origin still needs a token").isEqualTo(401);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000"})
    class DisabledByDefault extends Base {
        @Test
        void withoutConfigurationNoOriginIsEverAllowed() {
            var r = Http.send(Http.req(port, "/users/customers/1", token()).header("Origin", "http://localhost:3000").GET());
            assertThat(r.headers().firstValue("Access-Control-Allow-Origin")).isEmpty();
        }
    }

    private static String failure(String... props) {
        String[] all = new String[props.length + 4];
        System.arraycopy(props, 0, all, 0, props.length);
        all[props.length] = "server.port=0";
        all[props.length + 1] = "pso.service.name=users-service";
        all[props.length + 2] = "pso.security.cors.enabled=true";
        all[props.length + 3] = "logging.level.root=OFF";
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(TestApp.class).properties(all).run()) {
            throw new AssertionError("the application was expected to refuse to start");
        } catch (AssertionError e) {
            throw e;
        } catch (Throwable t) {
            StringBuilder sb = new StringBuilder();
            for (Throwable c = t; c != null; c = c.getCause()) {
                sb.append(c.getMessage()).append('\n');
            }
            return sb.toString();
        }
    }

    @Test
    void enabledWithoutOriginsRefusesToStartInsteadOfAllowingEverything() {
        assertThat(failure()).contains("requires allowed-origins");
    }

    @Test
    void wildcardOriginIsRejected() {
        assertThat(failure("pso.security.cors.allowed-origins[0]=*")).contains("wildcards are not allowed");
    }

    @Test
    void malformedOriginsAreRejected() {
        assertThat(failure("pso.security.cors.allowed-origins[0]=localhost:3000")).contains("must start with http");
        assertThat(failure("pso.security.cors.allowed-origins[0]=http://localhost:3000/")).contains("no path");
        assertThat(failure("pso.security.cors.allowed-origins[0]=ftp://example.com")).contains("must start with http");
        assertThat(failure("pso.security.cors.allowed-origins[0]=http://user:pw@example.com")).contains("credentials");
    }

    @Test
    void wildcardPatternsCannotBeCombinedWithCredentials() {
        assertThat(failure("pso.security.cors.allowed-origin-patterns[0]=https://*.example.com", "pso.security.cors.allow-credentials=true")).contains("cannot be combined with wildcard");
        assertThat(failure("pso.security.cors.allowed-origin-patterns[0]=*")).contains("allowed-origin-patterns");
    }

    @Test
    void wildcardHeadersAndUnknownMethodsAreRejected() {
        assertThat(failure("pso.security.cors.allowed-origins[0]=http://localhost:3000", "pso.security.cors.allowed-headers[0]=*")).contains("explicit header names");
        assertThat(failure("pso.security.cors.allowed-origins[0]=http://localhost:3000", "pso.security.cors.allowed-methods[0]=EXPLODE")).contains("allowed-methods");
    }
}
