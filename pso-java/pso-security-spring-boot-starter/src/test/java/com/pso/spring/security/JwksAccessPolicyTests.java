package com.pso.spring.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pso.spring.autoconfigure.PsoProperties;
import com.sun.net.httpserver.HttpServer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * Where a Spring service may fetch signing keys from: the same narrow rule as the TypeScript orchestrator. A private, link-local or
 * reserved address is refused unless the endpoint was approved by naming it exactly (host:port, https); redirects are never followed.
 */
class JwksAccessPolicyTests {

    private static PsoProperties.Jwt jwt(String jwksUri, String... privateHosts) {
        PsoProperties.Jwt cfg = new PsoProperties.Jwt();
        cfg.setJwksUri(jwksUri);
        cfg.setIssuer("https://idp.example");
        cfg.setAudience("pso-api");
        cfg.setPrivateHosts(List.of(privateHosts));
        return cfg;
    }

    @Test
    void privateLinkLocalSharedAndReservedAddressesAreBlockedAndLoopbackIsNot() throws Exception {
        for (String ip : List.of("10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.10", "169.254.169.254", "100.64.0.1", "100.127.255.255", "192.0.0.8",
            "198.18.0.1", "198.19.255.255", "224.0.0.1", "240.0.0.1", "0.0.0.0", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::", "64:ff9b::a00:5")) {
            assertThat(JwksAccessPolicy.blocked(InetAddress.getByName(ip))).as(ip).isTrue();
        }
        for (String ip : List.of("127.0.0.1", "127.8.8.8", "::1", "8.8.8.8", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.20.0.1", "2606:4700::1111", "64:ff9b::808:808")) {
            assertThat(JwksAccessPolicy.blocked(InetAddress.getByName(ip))).as(ip).isFalse();
        }
    }

    @Test
    void anApprovalNamesOneHttpsEndpointExactly() {
        URI jwks = URI.create("https://idp.internal:8443/jwks");
        assertThat(JwksAccessPolicy.approved(jwks, List.of("idp.internal:8443"))).isTrue();
        assertThat(JwksAccessPolicy.approved(jwks, List.of(" IDP.internal:8443 "))).as("case and surrounding blanks do not matter").isTrue();
        assertThat(JwksAccessPolicy.approved(jwks, List.of("idp.internal:443"))).as("another port").isFalse();
        assertThat(JwksAccessPolicy.approved(jwks, List.of("other.internal:8443"))).as("another host").isFalse();
        assertThat(JwksAccessPolicy.approved(jwks, List.of())).isFalse();
        assertThat(JwksAccessPolicy.approved(URI.create("https://idp.internal/jwks"), List.of("idp.internal:443"))).as("the default https port").isTrue();
        assertThat(JwksAccessPolicy.approved(URI.create("http://idp.internal:8443/jwks"), List.of("idp.internal:8443"))).as("never over plain http").isFalse();
        // the list accepts host:port and nothing else: no wildcard, scheme or path can widen it
        assertThat(JwksAccessPolicy.listProblems(List.of("idp.internal:8443", "[fd00::5]:443", ""))).isEmpty();
        for (String bad : List.of("*", "*.internal:443", "idp.internal", "https://idp.internal:443", "idp.internal:443/jwks", "10.0.0.0/8")) {
            assertThat(JwksAccessPolicy.listProblems(List.of(bad))).as(bad).hasSize(1).first().asString().contains("is not host:port");
        }
    }

    @Test
    void aJwksEndpointOnAPrivateAddressIsRefusedAtStartupUnlessItIsApproved() {
        for (String uri : List.of("https://10.0.0.5/jwks", "https://192.168.1.10:8443/jwks", "https://169.254.169.254/latest/meta-data", "https://[fd00::5]/jwks")) {
            assertThatThrownBy(() -> PsoJwtDecoderFactory.create(jwt(uri))).as(uri).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("pso.security.jwt.jwks-uri").hasMessageContaining("private").hasMessageContaining("pso.security.jwt.private-hosts");
        }
        // approving ANOTHER endpoint does not cover this one
        assertThatThrownBy(() -> PsoJwtDecoderFactory.create(jwt("https://10.0.0.5/jwks", "10.0.0.6:443"))).hasMessageContaining("private");
        assertThatThrownBy(() -> PsoJwtDecoderFactory.create(jwt("https://10.0.0.5:8443/jwks", "10.0.0.5:443"))).hasMessageContaining("private");
        // the exact endpoint, approved by name, is accepted (nothing is fetched until a token is validated)
        assertThat(PsoJwtDecoderFactory.create(jwt("https://10.0.0.5:8443/jwks", "10.0.0.5:8443"))).isNotNull();
        // a public address and loopback need no approval; an invalid approval list is a configuration error
        assertThat(PsoJwtDecoderFactory.create(jwt("https://8.8.8.8/jwks"))).isNotNull();
        assertThat(PsoJwtDecoderFactory.create(jwt("http://127.0.0.1:9/jwks"))).isNotNull();
        assertThatThrownBy(() -> PsoJwtDecoderFactory.create(jwt("https://8.8.8.8/jwks", "*.internal:443"))).hasMessageContaining("is not host:port");
    }

    @Test
    void aRedirectFromTheJwksEndpointIsNeverFollowed() throws Exception {
        AtomicInteger first = new AtomicInteger();
        AtomicInteger second = new AtomicInteger();
        HttpServer target = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        target.createContext("/", ex -> { second.incrementAndGet(); byte[] b = "{\"keys\":[]}".getBytes(); ex.getResponseHeaders().add("Content-Type", "application/json"); ex.sendResponseHeaders(200, b.length); ex.getResponseBody().write(b); ex.close(); });
        target.start();
        HttpServer idp = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        idp.createContext("/", ex -> { first.incrementAndGet(); ex.getResponseHeaders().add("Location", "http://127.0.0.1:" + target.getAddress().getPort() + "/jwks"); ex.sendResponseHeaders(302, -1); ex.close(); });
        idp.start();
        try {
            JwtDecoder decoder = PsoJwtDecoderFactory.create(jwt("http://127.0.0.1:" + idp.getAddress().getPort() + "/jwks"));
            // a syntactically valid, unsigned-by-anyone token: validating it needs the key set, which triggers the JWKS request
            String token = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1In0.c2lnbmF0dXJl";
            assertThatThrownBy(() -> decoder.decode(token)).isInstanceOf(org.springframework.security.oauth2.jwt.JwtException.class);
            assertThat(first.get()).as("the configured endpoint was asked").isGreaterThan(0);
            assertThat(second.get()).as("the redirect target was never contacted").isZero();
        } finally {
            idp.stop(0);
            target.stop(0);
        }
    }
}
