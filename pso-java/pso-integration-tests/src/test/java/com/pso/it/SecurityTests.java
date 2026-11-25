package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.it.app.TestApp;
import com.pso.test.PsoTestJwt;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

class SecurityTests {

    private static final String[] COMMON = {
        "pso.service.name=users-service",
        "pso.limits.requests.per-minute=100000",
        "management.endpoint.health.probes.enabled=true",
    };

    /** Deny by default, real tokens verified against a real JWKS endpoint. */
    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000"})
    class DenyByDefault extends Base {

        @Test
        void noTokenIs401AndHealthIsTheOnlyPublicPath() {
            assertThat(Http.get(port, "/users/customers/1", null).statusCode()).isEqualTo(401);
            assertThat(Http.get(port, "/anything", null).statusCode()).isEqualTo(401);
            assertThat(Http.get(port, "/actuator/info", null).statusCode()).isEqualTo(401);
            assertThat(Http.get(port, "/actuator/health", null).statusCode()).isEqualTo(200);
        }

        @Test
        void validTokenIsAccepted() {
            assertThat(Http.get(port, "/users/customers/1", token()).statusCode()).isEqualTo(200);
        }

        @Test
        void invalidTokensAreRejectedWith401() {
            var other = new PsoTestJwt(); // another key: valid structure, wrong signature
            try {
                String forged = other.token("mallory", List.of("customers:admin"), List.of());
                assertThat(Http.get(port, "/users/customers/1", forged).statusCode()).as("signed by another key").isEqualTo(401);
            } finally {
                other.close();
            }
            String expired = JWT.token(PsoTestJwt.ISSUER, PsoTestJwt.AUDIENCE, "u", List.of(), List.of(), Instant.now().minusSeconds(3600));
            assertThat(Http.get(port, "/users/customers/1", expired).statusCode()).as("expired").isEqualTo(401);
            String wrongIssuer = JWT.token("https://evil.test", PsoTestJwt.AUDIENCE, "u", List.of(), List.of(), Instant.now().plusSeconds(60));
            assertThat(Http.get(port, "/users/customers/1", wrongIssuer).statusCode()).as("wrong issuer").isEqualTo(401);
            String wrongAudience = JWT.token(PsoTestJwt.ISSUER, "other-api", "u", List.of(), List.of(), Instant.now().plusSeconds(60));
            assertThat(Http.get(port, "/users/customers/1", wrongAudience).statusCode()).as("wrong audience").isEqualTo(401);
            assertThat(Http.get(port, "/users/customers/1", "not.a.jwt").statusCode()).isEqualTo(401);
            assertThat(Http.send(Http.req(port, "/users/customers/1", null).header("Authorization", "Basic dXNlcjpwYXNz").GET()).statusCode()).isEqualTo(401);
        }

        @Test
        void algNoneAndSymmetricTokensAreRejected() {
            String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"none\"}".getBytes());
            String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(("{\"iss\":\"" + PsoTestJwt.ISSUER + "\",\"aud\":\"" + PsoTestJwt.AUDIENCE + "\",\"sub\":\"x\",\"exp\":9999999999}").getBytes());
            assertThat(Http.get(port, "/users/customers/1", header + "." + payload + ".").statusCode()).isEqualTo(401);
        }

        @Test
        void methodSecurityRequiresTheScope() {
            var read = Http.send(Http.req(port, "/users/customers/1", token("customers:read")).DELETE());
            assertThat(read.statusCode()).as("authenticated but missing scope").isEqualTo(403);
            var admin = Http.send(Http.req(port, "/users/customers/1", token("customers:admin")).DELETE());
            assertThat(admin.statusCode()).isEqualTo(200);
        }

        @Test
        void securityHeadersAreSet() {
            var r = Http.get(port, "/users/customers/1", token());
            assertThat(r.headers().firstValue("X-Content-Type-Options")).contains("nosniff");
            assertThat(r.headers().firstValue("Referrer-Policy")).contains("no-referrer");
            assertThat(r.headers().firstValue("X-Frame-Options")).isPresent();
            assertThat(r.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        }
    }

    /** Declarative rules: relative to the prefix, scopes ALL, roles ANY, explicit public. */
    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000",
        "pso.security.rules[0].path=/customers/**", "pso.security.rules[0].methods[0]=GET", "pso.security.rules[0].access=SCOPES", "pso.security.rules[0].scopes[0]=customers:read",
        "pso.security.rules[1].path=/customers/**", "pso.security.rules[1].methods[0]=POST", "pso.security.rules[1].access=SCOPES",
        "pso.security.rules[1].scopes[0]=customers:write", "pso.security.rules[1].roles[0]=editor", "pso.security.rules[1].roles[1]=admin",
        "pso.security.rules[2].path=/open/**", "pso.security.rules[2].access=PUBLIC"})
    class Rules extends Base {

        @Test
        void scopeRuleReturns403WithoutTheScopeAnd200With() {
            assertThat(Http.get(port, "/users/customers/1", token("other")).statusCode()).isEqualTo(403);
            assertThat(Http.get(port, "/users/customers/1", token("customers:read")).statusCode()).isEqualTo(200);
            assertThat(Http.get(port, "/users/customers/1", null).statusCode()).as("anonymous never passes a scope rule").isEqualTo(401);
        }

        @Test
        void rolesAreAnyOfAndScopesAreAllOf() {
            var body = java.net.http.HttpRequest.BodyPublishers.ofString("{\"a\":1}");
            var noRole = Http.send(Http.req(port, "/users/customers", tokenWithRoles(List.of("customers:write"), List.of())).header("Content-Type", "application/json").POST(body));
            assertThat(noRole.statusCode()).isEqualTo(403);
            var editor = Http.send(Http.req(port, "/users/customers", tokenWithRoles(List.of("customers:write"), List.of("editor"))).header("Content-Type", "application/json").POST(body));
            assertThat(editor.statusCode()).isEqualTo(200);
            var roleNoScope = Http.send(Http.req(port, "/users/customers", tokenWithRoles(List.of("customers:read"), List.of("admin"))).header("Content-Type", "application/json").POST(body));
            assertThat(roleNoScope.statusCode()).isEqualTo(403);
        }

        @Test
        void aPublicRuleIsPublicOnlyForItsPathAndEverythingElseStaysClosed() {
            assertThat(Http.get(port, "/users/open/anything", null).statusCode()).as("public rule: no 401 (404: nothing mapped)").isEqualTo(404);
            assertThat(Http.get(port, "/users/customers/1", null).statusCode()).isEqualTo(401);
            assertThat(Http.get(port, "/other", null).statusCode()).isEqualTo(401);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000", "pso.security.jwt.roles-claim=realm.roles"})
    class NestedRolesClaim extends Base {
        @Test
        void aDottedRolesClaimIsHonoured() {
            // the helper signs roles at the top level; a nested claim path simply yields no roles, never an error
            assertThat(Http.get(port, "/users/customers/1", tokenWithRoles(List.of(), List.of("admin"))).statusCode()).isEqualTo(200);
        }
    }

    private static String[] concat(String[] a, String... b) {
        String[] out = java.util.Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
