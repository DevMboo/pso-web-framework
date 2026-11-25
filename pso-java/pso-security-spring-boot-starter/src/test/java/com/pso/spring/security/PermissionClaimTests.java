package com.pso.spring.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.spring.autoconfigure.PsoProperties;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Where a token carries its permissions. Providers differ: Keycloak and Azure AD keep the OpenID scopes in `scope` and the user's permissions
 * in `scp`; Spring's default converter reads only the first claim it finds, which dropped the permissions of a valid Keycloak token. The
 * converter must read both, like the TypeScript orchestrator does.
 */
class PermissionClaimTests {

    private static Jwt token(java.util.function.Consumer<Jwt.Builder> claims) {
        Jwt.Builder b = Jwt.withTokenValue("t").header("alg", "RS256").subject("u").issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(60));
        claims.accept(b);
        return b.build();
    }

    private static Set<String> authorities(Jwt jwt) {
        PsoProperties props = new PsoProperties();
        var converter = new PsoSecurityAutoConfiguration().psoJwtAuthenticationConverter(props);
        return converter.convert(jwt).getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
    }

    @Test
    void scopeAndScpAreCombined() {
        assertThat(authorities(token(b -> b.claim("scope", "openid profile").claim("scp", List.of("customers:read", "orders:write")))))
            .containsExactlyInAnyOrder("SCOPE_openid", "SCOPE_profile", "SCOPE_customers:read", "SCOPE_orders:write");
    }

    @Test
    void eachClaimAloneStillWorks() {
        assertThat(authorities(token(b -> b.claim("scope", "customers:read orders:read")))).containsExactlyInAnyOrder("SCOPE_customers:read", "SCOPE_orders:read");
        assertThat(authorities(token(b -> b.claim("scp", List.of("catalog:read"))))).containsExactlyInAnyOrder("SCOPE_catalog:read");
        assertThat(authorities(token(b -> b.claim("scp", "catalog:read catalog:write")))).containsExactlyInAnyOrder("SCOPE_catalog:read", "SCOPE_catalog:write");
    }

    @Test
    void duplicatesAreOneAuthorityAndNothingIsInvented() {
        assertThat(authorities(token(b -> b.claim("scope", "a:read").claim("scp", List.of("a:read"))))).containsExactly("SCOPE_a:read");
        assertThat(authorities(token(b -> b.claim("sub2", "x")))).isEmpty();
        assertThat(authorities(token(b -> b.claim("scope", "")))).isEmpty();
    }

    @Test
    void permissionsOfAnotherClaimNameAreNotTrusted() {
        // only `scope`, `scp` (and the configured roles claim) grant anything: a `permissions` or `scopes` claim is ignored
        assertThat(authorities(token(b -> b.claim("permissions", List.of("customers:write")).claim("scopes", List.of("customers:write"))))).isEmpty();
    }

    @Test
    void rolesComeFromTheConfiguredClaimOnly() {
        assertThat(authorities(token(b -> b.claim("roles", List.of("admin")).claim("scp", List.of("a:read")))))
            .containsExactlyInAnyOrder("ROLE_admin", "SCOPE_a:read");
        assertThat(authorities(token(b -> b.claim("roles", List.of("not valid!"))))).isEmpty();
    }
}
