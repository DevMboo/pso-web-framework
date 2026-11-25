package com.pso.test;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.UUID;

/**
 * Test support: an ES256 signing key, a loopback JWKS endpoint serving its public half, and a token factory. Tests then run real
 * signature, issuer, audience and expiry validation instead of mocking the decoder. Close it when the test class ends.
 */
public final class PsoTestJwt implements AutoCloseable {

    public static final String ISSUER = "https://idp.test";
    public static final String AUDIENCE = "pso-api";

    private final ECKey key;
    private final HttpServer server;

    public PsoTestJwt() {
        try {
            this.key = new ECKeyGenerator(Curve.P_256).keyID("test-key").generate();
            byte[] jwks = new JWKSet(key.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
            this.server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            server.createContext("/jwks", ex -> {
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(200, jwks.length);
                ex.getResponseBody().write(jwks);
                ex.close();
            });
            server.start();
        } catch (JOSEException | IOException e) {
            throw new IllegalStateException("cannot start the test JWKS endpoint", e);
        }
    }

    public String jwksUri() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/jwks";
    }

    /** A valid token for {@link #ISSUER} / {@link #AUDIENCE} expiring in five minutes. */
    public String token(String subject, List<String> scopes, List<String> roles) {
        return token(ISSUER, AUDIENCE, subject, scopes, roles, Instant.now().plusSeconds(300));
    }

    public String token(String issuer, String audience, String subject, List<String> scopes, List<String> roles, Instant expires) {
        try {
            JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer(issuer).audience(audience).subject(subject).jwtID(UUID.randomUUID().toString())
                .issueTime(new Date()).expirationTime(Date.from(expires))
                .claim("scope", String.join(" ", scopes))
                .claim("roles", roles);
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.ES256).keyID(key.getKeyID()).build(), claims.build());
            jwt.sign(new ECDSASigner(key));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException("cannot sign the test token", e);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
