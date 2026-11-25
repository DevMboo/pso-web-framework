package com.pso.it;

import com.pso.test.PsoTestJwt;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Shared test identity provider: a real signing key and a real JWKS endpoint on loopback. */
abstract class Base {

    static final PsoTestJwt JWT = new PsoTestJwt();

    @LocalServerPort
    int port;

    @DynamicPropertySource
    static void jwt(DynamicPropertyRegistry r) {
        r.add("pso.security.jwt.jwks-uri", JWT::jwksUri);
        r.add("pso.security.jwt.issuer", () -> PsoTestJwt.ISSUER);
        r.add("pso.security.jwt.audience", () -> PsoTestJwt.AUDIENCE);
        r.add("pso.security.jwt.algorithms", () -> "ES256");
    }

    @AfterAll
    static void noop() {
        // the JWKS endpoint is shared by every test class in the JVM and stops with it
    }

    static String token(String... scopes) {
        return JWT.token("user-1", List.of(scopes), List.of());
    }

    static String tokenWithRoles(List<String> scopes, List<String> roles) {
        return JWT.token("user-1", scopes, roles);
    }
}
