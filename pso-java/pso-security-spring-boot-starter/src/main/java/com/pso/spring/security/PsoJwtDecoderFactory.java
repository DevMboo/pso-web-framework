package com.pso.spring.security;

import com.pso.spring.autoconfigure.PsoProperties;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

/**
 * Builds the JWT decoder from {@code pso.security.jwt.*} using Spring Security / Nimbus (no custom cryptography): asymmetric
 * algorithms only, issuer, audience, expiry and not-before with a bounded clock skew, and a non-empty subject.
 */
final class PsoJwtDecoderFactory {

    private static final Set<String> ALLOWED = Set.of("RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512");

    private PsoJwtDecoderFactory() {
    }

    /** A decoder that rejects every token: the fail-closed behavior when JWT validation is not configured at all. */
    static JwtDecoder rejectAll() {
        return token -> {
            throw new BadJwtException("JWT validation is not configured");
        };
    }

    static JwtDecoder create(PsoProperties.Jwt cfg) {
        List<String> problems = new ArrayList<>();
        if (blank(cfg.getJwksUri())) {
            problems.add("pso.security.jwt.jwks-uri is required");
        }
        if (blank(cfg.getIssuer())) {
            problems.add("pso.security.jwt.issuer is required");
        }
        if (blank(cfg.getAudience())) {
            problems.add("pso.security.jwt.audience is required");
        }
        if (cfg.getAlgorithms().isEmpty()) {
            problems.add("pso.security.jwt.algorithms must list at least one asymmetric algorithm");
        }
        for (String a : cfg.getAlgorithms()) {
            if (!ALLOWED.contains(a)) {
                problems.add("pso.security.jwt.algorithms: \"" + a + "\" is not allowed (asymmetric only: " + new java.util.TreeSet<>(ALLOWED) + ")");
            }
        }
        if (cfg.getClockSkew() == null || cfg.getClockSkew().isNegative() || cfg.getClockSkew().toSeconds() > 300) {
            problems.add("pso.security.jwt.clock-skew must be between 0 and 5 minutes");
        }
        problems.addAll(JwksAccessPolicy.listProblems(cfg.getPrivateHosts()));
        boolean approved = false;
        URI jwks = null;
        if (!blank(cfg.getJwksUri())) {
            String why = jwksProblem(cfg.getJwksUri());
            if (why != null) {
                problems.add("pso.security.jwt.jwks-uri: " + why);
            } else {
                jwks = URI.create(cfg.getJwksUri());
                approved = JwksAccessPolicy.approved(jwks, cfg.getPrivateHosts());
                // checked now when the name resolves, and again before every request (see restOperations)
                String refusal = JwksAccessPolicy.refusal(jwks, approved);
                if (refusal != null) {
                    problems.add("pso.security.jwt.jwks-uri: " + refusal);
                }
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Invalid JWT configuration:\n - " + String.join("\n - ", problems));
        }
        NimbusJwtDecoder.JwkSetUriJwtDecoderBuilder builder = NimbusJwtDecoder.withJwkSetUri(cfg.getJwksUri());
        // one client for every configuration: bounded, never following a redirect, and refusing an endpoint on a private network
        // that was not approved by name
        builder.restOperations(restOperations(blank(cfg.getCaFile()) ? null : cfg.getCaFile(), jwks, approved));
        for (String a : cfg.getAlgorithms()) {
            builder.jwsAlgorithm(SignatureAlgorithm.from(a));
        }
        NimbusJwtDecoder decoder = builder.build();
        String audience = cfg.getAudience();
        OAuth2TokenValidator<Jwt> aud = new JwtClaimValidator<Object>("aud", v -> v instanceof java.util.Collection<?> c ? c.contains(audience) : audience.equals(v));
        OAuth2TokenValidator<Jwt> sub = new JwtClaimValidator<Object>("sub", v -> v instanceof String s && !s.isBlank());
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(new JwtTimestampValidator(cfg.getClockSkew()), new JwtIssuerValidator(cfg.getIssuer()), aud, sub));
        return decoder;
    }

    /** Kept for callers that only need the private certificate authority (no address policy): see the three-argument form. */
    static org.springframework.web.client.RestOperations restOperations(String caFile) {
        return restOperations(caFile, null, true);
    }

    /**
     * The HTTP client of the JWKS request: connect and read timeouts, redirects never followed and, before every request, the
     * address policy of {@link JwksAccessPolicy} (an endpoint on a private network must have been approved by name).
     * With {@code caFile} (an identity provider whose certificate is signed by a private certificate authority) the only trust
     * anchors are the certificates of that PEM file; without it the JVM trust store is used. Verification stays on (chain, validity,
     * host name) in both cases; a file that cannot be read or holds no certificate stops start-up.
     */
    static org.springframework.web.client.RestOperations restOperations(String caFile, URI jwks, boolean approved) {
        try {
            java.net.http.HttpClient.Builder http = java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(5))
                .followRedirects(java.net.http.HttpClient.Redirect.NEVER);
            if (caFile != null) {
                java.security.KeyStore trust = java.security.KeyStore.getInstance(java.security.KeyStore.getDefaultType());
                trust.load(null, null);
                int n = 0;
                try (java.io.InputStream in = java.nio.file.Files.newInputStream(java.nio.file.Path.of(caFile))) {
                    for (java.security.cert.Certificate c : java.security.cert.CertificateFactory.getInstance("X.509").generateCertificates(in)) {
                        trust.setCertificateEntry("pso-jwks-ca-" + n++, c);
                    }
                }
                if (n == 0) {
                    throw new IllegalStateException("pso.security.jwt.ca-file contains no certificate: " + caFile);
                }
                javax.net.ssl.TrustManagerFactory tmf = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());
                tmf.init(trust);
                javax.net.ssl.SSLContext ctx = javax.net.ssl.SSLContext.getInstance("TLS");
                ctx.init(null, tmf.getTrustManagers(), null);
                http.sslContext(ctx);
            }
            org.springframework.http.client.JdkClientHttpRequestFactory factory = new org.springframework.http.client.JdkClientHttpRequestFactory(http.build());
            factory.setReadTimeout(java.time.Duration.ofSeconds(5));
            org.springframework.web.client.RestTemplate rest = new org.springframework.web.client.RestTemplate(factory);
            if (jwks != null) {
                rest.getInterceptors().add((request, body, execution) -> {
                    // only the configured endpoint is ever requested, and only while its address is acceptable
                    URI target = request.getURI();
                    if (!java.util.Objects.equals(target.getHost(), jwks.getHost()) || target.getPort() != jwks.getPort()) {
                        throw new java.io.IOException("the JWKS request was refused: it does not target the configured endpoint");
                    }
                    String refusal = JwksAccessPolicy.refusal(target, approved);
                    if (refusal != null) {
                        throw new java.io.IOException("the JWKS request was refused: " + refusal);
                    }
                    return execution.execute(request, body);
                });
            }
            return rest;
        } catch (java.io.IOException | java.security.GeneralSecurityException e) {
            throw new IllegalStateException("pso.security.jwt.ca-file cannot be used (" + e.getClass().getSimpleName() + "): " + caFile);
        }
    }

    /** https is required except for loopback (development); credentials in the URL are never allowed. */
    static String jwksProblem(String raw) {
        URI u;
        try {
            u = new URI(raw);
        } catch (URISyntaxException e) {
            return "not a valid URL";
        }
        if (u.getHost() == null || u.getScheme() == null) {
            return "must be an absolute URL";
        }
        if (u.getUserInfo() != null) {
            return "credentials in the URL are not allowed";
        }
        boolean loopback = u.getHost().equals("localhost") || u.getHost().equals("127.0.0.1") || u.getHost().equals("[::1]") || u.getHost().equals("::1");
        if (u.getScheme().equals("https") || (u.getScheme().equals("http") && loopback)) {
            return null;
        }
        return "must use https (plain http is accepted only for loopback in development)";
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
