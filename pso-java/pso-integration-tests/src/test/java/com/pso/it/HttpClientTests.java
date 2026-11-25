package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.http.DefaultPsoHttpClient;
import com.pso.spring.http.PsoHttpException;
import com.pso.spring.http.PsoHttpException.Kind;
import com.pso.spring.http.PsoRequest;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsParameters;
import com.sun.net.httpserver.HttpsServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.MDC;
import org.springframework.http.HttpMethod;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.util.unit.DataSize;

/** The PSO HTTP client against real servers on loopback (plain, TLS and mutual TLS): no mocked transport. */
class HttpClientTests {

    private final List<HttpServer> servers = new ArrayList<>();

    @AfterEach
    void stop() {
        servers.forEach(s -> s.stop(0));
        servers.clear();
        SecurityContextHolder.clearContext();
        MDC.clear();
    }

    /** A loopback server answering through {@code handler}; records every request it receives. */
    private HttpServer serve(HttpHandler handler) throws IOException {
        HttpServer s = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        s.createContext("/", handler);
        s.start();
        servers.add(s);
        return s;
    }

    private static String url(HttpServer s) {
        return "http://127.0.0.1:" + s.getAddress().getPort();
    }

    private static void reply(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length == 0 ? -1 : b.length);
        if (b.length > 0) {
            ex.getResponseBody().write(b);
        }
        ex.close();
    }

    private static PsoProperties.Remote remote(String baseUrl) {
        PsoProperties.Remote r = new PsoProperties.Remote();
        r.setBaseUrl(baseUrl);
        r.setReadTimeout(Duration.ofSeconds(3));
        r.getRetry().setBackoff(Duration.ofMillis(10));
        return r;
    }

    private static DefaultPsoHttpClient client(Map<String, PsoProperties.Remote> services) {
        PsoProperties p = new PsoProperties();
        p.getHttp().getClient().setServices(new java.util.LinkedHashMap<>(services));
        return new DefaultPsoHttpClient(p);
    }

    record Customer(String id, String name) {
    }

    @Test
    void getsTypedJsonThroughNamedServicesAndExpandsUriVariables() throws Exception {
        List<String> paths = new CopyOnWriteArrayList<>();
        HttpServer s = serve(ex -> { paths.add(ex.getRequestURI().toString()); reply(ex, 200, "{\"id\":\"7\",\"name\":\"Ada\"}"); });
        DefaultPsoHttpClient http = client(Map.of("customers", remote(url(s))));
        Customer c = http.get("customers", "/customers/{id}", Customer.class, "7");
        assertThat(c).isEqualTo(new Customer("7", "Ada"));
        http.get("customers", "/customers/{id}", Customer.class, "a b/../c"); // variables are encoded, they cannot change the path
        assertThat(paths.get(0)).isEqualTo("/customers/7");
        assertThat(paths.get(1)).doesNotContain("/../").contains("%2F");
    }

    @Test
    void postAndDeleteWork() throws Exception {
        List<String> seen = new CopyOnWriteArrayList<>();
        HttpServer s = serve(ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            seen.add(ex.getRequestMethod() + " " + ex.getRequestURI() + " " + body);
            reply(ex, ex.getRequestMethod().equals("DELETE") ? 204 : 201, ex.getRequestMethod().equals("DELETE") ? "" : "{\"id\":\"9\",\"name\":\"New\"}");
        });
        DefaultPsoHttpClient http = client(Map.of("customers", remote(url(s))));
        Customer created = http.post("customers", "/customers", new Customer(null, "New"), Customer.class);
        assertThat(created.id()).isEqualTo("9");
        http.delete("customers", "/customers/{id}", "9");
        assertThat(seen.get(0)).startsWith("POST /customers ").contains("\"name\":\"New\"");
        assertThat(seen.get(1)).isEqualTo("DELETE /customers/9 ");
    }

    // ------------------------------------------------------------------ destination policy

    @Test
    void onlyDeclaredServicesAndRelativePathsAreEverContacted() throws Exception {
        AtomicInteger hits = new AtomicInteger();
        HttpServer s = serve(ex -> { hits.incrementAndGet(); reply(ex, 200, "{}"); });
        DefaultPsoHttpClient http = client(Map.of("customers", remote(url(s))));
        assertThatThrownBy(() -> http.get("unknown", "/x", String.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.POLICY));
        for (String bad : new String[] {"http://evil.test/x", "//evil.test/x", "x", "/a/../b", "/a/%2e%2e/b", "/a%2Fb", "/a\\b", "/x\r\nHeader: 1", ""}) {
            assertThatThrownBy(() -> http.get("customers", bad, String.class)).as(bad).isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.POLICY));
        }
        assertThat(hits.get()).as("nothing reached the network").isZero();
    }

    @Test
    void redirectsAreNeverFollowed() throws Exception {
        AtomicInteger elsewhere = new AtomicInteger();
        HttpServer other = serve(ex -> { elsewhere.incrementAndGet(); reply(ex, 200, "{}"); });
        HttpServer s = serve(ex -> { ex.getResponseHeaders().add("Location", url(other) + "/stolen"); ex.sendResponseHeaders(302, -1); ex.close(); });
        DefaultPsoHttpClient http = client(Map.of("customers", remote(url(s))));
        try {
            http.get("customers", "/x", String.class);
        } catch (PsoHttpException expected) {
            // a 3xx is not a success either way; what matters is that no second host was contacted
        }
        assertThat(elsewhere.get()).isZero();
    }

    @Test
    void invalidServiceConfigurationFailsAtStartup() {
        PsoProperties.Remote http = remote("http://example.com");
        assertThatThrownBy(() -> client(Map.of("remote", http))).hasMessageContaining("plain http is refused");
        PsoProperties.Remote creds = remote("https://user:pw@example.com");
        assertThatThrownBy(() -> client(Map.of("remote", creds))).hasMessageContaining("credentials");
        PsoProperties.Remote junk = remote("not a url");
        assertThatThrownBy(() -> client(Map.of("remote", junk))).hasMessageContaining("pso.http.client.services.remote");
        PsoProperties.Remote ok = remote("http://example.com");
        ok.setAllowInsecureHttp(true);
        client(Map.of("remote", ok)); // explicit opt-in is accepted
        PsoProperties.Remote badTimeout = remote("https://example.com");
        badTimeout.setReadTimeout(Duration.ZERO);
        assertThatThrownBy(() -> client(Map.of("remote", badTimeout))).hasMessageContaining("timeouts must be positive");
    }

    // ------------------------------------------------------------------ timeouts, size, errors

    @Test
    void readTimeoutIsEnforced() throws Exception {
        HttpServer s = serve(ex -> { try { Thread.sleep(1500); } catch (InterruptedException ignored) { /* test server */ } reply(ex, 200, "{}"); });
        PsoProperties.Remote r = remote(url(s));
        r.setReadTimeout(Duration.ofMillis(250));
        r.getRetry().setMaxAttempts(1);
        DefaultPsoHttpClient http = client(Map.of("slow", r));
        long t0 = System.nanoTime();
        assertThatThrownBy(() -> http.get("slow", "/x", String.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.TIMEOUT));
        assertThat(Duration.ofNanos(System.nanoTime() - t0)).isLessThan(Duration.ofSeconds(1));
    }

    @Test
    void connectionFailuresAreMappedSafely() {
        PsoProperties.Remote r = remote("http://127.0.0.1:1");
        r.getRetry().setMaxAttempts(1);
        DefaultPsoHttpClient http = client(Map.of("down", r));
        assertThatThrownBy(() -> http.get("down", "/secret?token=abc", String.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> {
            assertThat(e.kind()).isEqualTo(Kind.CONNECT);
            assertThat(e.getMessage()).doesNotContain("token=abc").doesNotContain("127.0.0.1");
        });
    }

    @Test
    void oversizedResponsesAreRejected() throws Exception {
        String big = "{\"id\":\"1\",\"name\":\"" + "x".repeat(5000) + "\"}";
        HttpServer declared = serve(ex -> reply(ex, 200, big));
        PsoProperties.Remote r = remote(url(declared));
        r.setMaxResponseSize(DataSize.ofBytes(1000));
        assertThatThrownBy(() -> client(Map.of("big", r)).get("big", "/x", Customer.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.RESPONSE_TOO_LARGE));
        // no Content-Length (chunked): the limit is enforced on the bytes read
        HttpServer chunked = serve(ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(200, 0);
            ex.getResponseBody().write(big.getBytes(StandardCharsets.UTF_8));
            ex.close();
        });
        PsoProperties.Remote r2 = remote(url(chunked));
        r2.setMaxResponseSize(DataSize.ofBytes(1000));
        assertThatThrownBy(() -> client(Map.of("big", r2)).get("big", "/x", Customer.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.RESPONSE_TOO_LARGE));
    }

    @Test
    void remoteErrorsAreMappedWithoutLeakingTheirBody() throws Exception {
        HttpServer s = serve(ex -> reply(ex, ex.getRequestURI().getPath().equals("/missing") ? 404 : 500, "{\"stack\":\"SECRET INTERNALS\"}"));
        PsoProperties.Remote r = remote(url(s));
        r.getRetry().setMaxAttempts(1);
        DefaultPsoHttpClient http = client(Map.of("svc", r));
        assertThatThrownBy(() -> http.get("svc", "/missing", String.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> {
            assertThat(e.kind()).isEqualTo(Kind.REMOTE_CLIENT_ERROR);
            assertThat(e.status()).isEqualTo(404);
            assertThat(e.getMessage()).doesNotContain("SECRET");
        });
        assertThatThrownBy(() -> http.get("svc", "/boom", String.class)).isInstanceOfSatisfying(PsoHttpException.class, e -> {
            assertThat(e.kind()).isEqualTo(Kind.REMOTE_SERVER_ERROR);
            assertThat(e.getMessage()).doesNotContain("SECRET");
        });
    }

    // ------------------------------------------------------------------ retries

    @Test
    void idempotentRequestsAreRetriedOnTransientFailures() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        HttpServer s = serve(ex -> reply(ex, calls.incrementAndGet() < 3 ? 503 : 200, "{\"id\":\"1\",\"name\":\"ok\"}"));
        PsoProperties.Remote r = remote(url(s));
        r.getRetry().setMaxAttempts(3);
        assertThat(client(Map.of("svc", r)).get("svc", "/x", Customer.class).name()).isEqualTo("ok");
        assertThat(calls.get()).isEqualTo(3);
    }

    @Test
    void retriesStopAtMaxAttempts() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        HttpServer s = serve(ex -> { calls.incrementAndGet(); reply(ex, 503, "{}"); });
        PsoProperties.Remote r = remote(url(s));
        r.getRetry().setMaxAttempts(3);
        assertThatThrownBy(() -> client(Map.of("svc", r)).get("svc", "/x", String.class)).isInstanceOf(PsoHttpException.class);
        assertThat(calls.get()).isEqualTo(3);
    }

    @Test
    void clientErrorsAreNeverRetried() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        HttpServer s = serve(ex -> { calls.incrementAndGet(); reply(ex, 400, "{}"); });
        PsoProperties.Remote r = remote(url(s));
        r.getRetry().setMaxAttempts(4);
        assertThatThrownBy(() -> client(Map.of("svc", r)).get("svc", "/x", String.class)).isInstanceOf(PsoHttpException.class);
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    void nonIdempotentRequestsAreNotRetriedBlindly() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        HttpServer s = serve(ex -> { calls.incrementAndGet(); reply(ex, 503, "{}"); });
        PsoProperties.Remote r = remote(url(s));
        r.getRetry().setMaxAttempts(4);
        DefaultPsoHttpClient http = client(Map.of("svc", r));
        assertThatThrownBy(() -> http.post("svc", "/x", Map.of("a", 1), String.class)).isInstanceOf(PsoHttpException.class);
        assertThat(calls.get()).as("POST with default settings").isEqualTo(1);

        PsoProperties.Remote allowed = remote(url(s));
        allowed.getRetry().setMaxAttempts(4);
        allowed.getRetry().setRetryNonIdempotent(true);
        DefaultPsoHttpClient http2 = client(Map.of("svc", allowed));
        calls.set(0);
        assertThatThrownBy(() -> http2.post("svc", "/x", Map.of("a", 1), String.class)).isInstanceOf(PsoHttpException.class);
        assertThat(calls.get()).as("opt-in alone is not enough: an Idempotency-Key is required").isEqualTo(1);
        calls.set(0);
        assertThatThrownBy(() -> http2.exchange(PsoRequest.of(HttpMethod.POST, "svc", "/x").body(Map.of("a", 1)).idempotencyKey("key-1"), String.class)).isInstanceOf(PsoHttpException.class);
        assertThat(calls.get()).as("opt-in plus Idempotency-Key").isEqualTo(4);
    }

    // ------------------------------------------------------------------ credentials and correlation

    private Jwt jwt() {
        return new Jwt("caller-token-value", Instant.now(), Instant.now().plusSeconds(60), Map.of("alg", "none"), Map.of("sub", "caller"));
    }

    @Test
    void theBearerTokenIsForwardedOnlyToServicesThatAskForIt() throws Exception {
        List<String> auth = new CopyOnWriteArrayList<>();
        HttpServer s = serve(ex -> { auth.add(String.valueOf(ex.getRequestHeaders().getFirst("Authorization"))); reply(ex, 200, "{}"); });
        PsoProperties.Remote plain = remote(url(s));
        PsoProperties.Remote forwarding = remote(url(s));
        forwarding.setForwardBearer(true);
        DefaultPsoHttpClient http = client(Map.of("plain", plain, "trusted", forwarding));
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt(), java.util.List.of()));
        http.get("plain", "/x", String.class);
        http.get("trusted", "/x", String.class);
        assertThat(auth).containsExactly("null", "Bearer caller-token-value");
    }

    @Test
    void aRawAuthorizationHeaderFromTheCallerCannotBeSmuggledThrough() throws Exception {
        List<String> auth = new CopyOnWriteArrayList<>();
        HttpServer s = serve(ex -> { auth.add(String.valueOf(ex.getRequestHeaders().getFirst("Authorization"))); reply(ex, 200, "{}"); });
        PsoProperties.Remote forwarding = remote(url(s));
        forwarding.setForwardBearer(true);
        // no authenticated caller: nothing is forwarded even though the service allows forwarding
        client(Map.of("trusted", forwarding)).get("trusted", "/x", String.class);
        assertThat(auth).containsExactly("null");
    }

    @Test
    void correlationIdPropagatesIncludingThroughAsyncCalls() throws Exception {
        List<String> ids = new CopyOnWriteArrayList<>();
        HttpServer s = serve(ex -> { ids.add(String.valueOf(ex.getRequestHeaders().getFirst("X-Correlation-ID"))); reply(ex, 200, "{\"id\":\"1\",\"name\":\"a\"}"); });
        DefaultPsoHttpClient http = client(Map.of("svc", remote(url(s))));
        MDC.put("correlationId", "trace-0001-abcd");
        http.get("svc", "/x", Customer.class);
        Future<Customer> f = http.getAsync("svc", "/x", Customer.class);
        assertThat(f.get(5, TimeUnit.SECONDS).id()).isEqualTo("1");
        assertThat(ids).containsExactly("trace-0001-abcd", "trace-0001-abcd");
    }

    @Test
    void asyncCallsCanBeCancelled() throws Exception {
        AtomicInteger finished = new AtomicInteger();
        HttpServer s = serve(ex -> { try { Thread.sleep(3000); } catch (InterruptedException ignored) { /* server side */ } finished.incrementAndGet(); try { reply(ex, 200, "{}"); } catch (IOException ignored) { /* client gone */ } });
        PsoProperties.Remote r = remote(url(s));
        r.setReadTimeout(Duration.ofSeconds(10));
        r.getRetry().setMaxAttempts(1);
        DefaultPsoHttpClient http = client(Map.of("slow", r));
        Future<String> f = http.getAsync("slow", "/x", String.class);
        Thread.sleep(200);
        assertThat(f.cancel(true)).isTrue();
        assertThat(f.isCancelled()).isTrue();
        assertThatThrownBy(() -> f.get(1, TimeUnit.SECONDS)).isInstanceOf(java.util.concurrent.CancellationException.class);
    }

    // ------------------------------------------------------------------ TLS and mTLS

    static Path dir;
    static Path serverKs, trustOfServer, clientKs, trustOfClient, otherTrust;
    static final String PW = "changeit";

    @BeforeAll
    static void certificates(@TempDir Path tmp) throws Exception {
        dir = Files.createTempDirectory("pso-tls");
        serverKs = dir.resolve("server.p12");
        clientKs = dir.resolve("client.p12");
        keytool("-genkeypair", "-alias", "server", "-keyalg", "RSA", "-keysize", "2048", "-storetype", "PKCS12", "-keystore", serverKs.toString(), "-storepass", PW,
            "-dname", "CN=localhost", "-ext", "san=dns:localhost,ip:127.0.0.1", "-validity", "2");
        keytool("-genkeypair", "-alias", "client", "-keyalg", "RSA", "-keysize", "2048", "-storetype", "PKCS12", "-keystore", clientKs.toString(), "-storepass", PW,
            "-dname", "CN=pso-client", "-validity", "2");
        trustOfServer = dir.resolve("trust-server.p12"); // what the CLIENT trusts: the server certificate
        exportAndTrust(serverKs, "server", trustOfServer);
        trustOfClient = dir.resolve("trust-client.p12"); // what the SERVER trusts: the client certificate
        exportAndTrust(clientKs, "client", trustOfClient);
        // a trust store with an unrelated certificate (a different server key pair)
        Path unrelated = dir.resolve("unrelated.p12");
        keytool("-genkeypair", "-alias", "unrelated", "-keyalg", "RSA", "-keysize", "2048", "-storetype", "PKCS12", "-keystore", unrelated.toString(), "-storepass", PW, "-dname", "CN=unrelated", "-validity", "2");
        otherTrust = dir.resolve("trust-other.p12");
        exportAndTrust(unrelated, "unrelated", otherTrust);
    }

    private static void exportAndTrust(Path ks, String alias, Path trust) throws Exception {
        Path cer = dir.resolve(alias + ".cer");
        keytool("-exportcert", "-alias", alias, "-keystore", ks.toString(), "-storepass", PW, "-file", cer.toString());
        keytool("-importcert", "-noprompt", "-alias", alias, "-file", cer.toString(), "-keystore", trust.toString(), "-storepass", PW, "-storetype", "PKCS12");
    }

    private static void keytool(String... args) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add(Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        assertThat(p.waitFor()).as("keytool %s: %s", String.join(" ", args), out).isZero();
    }

    private static KeyStore load(Path file) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(file)) {
            ks.load(in, PW.toCharArray());
        }
        return ks;
    }

    private HttpsServer https(boolean requireClientCert) throws Exception {
        return https(serverKs, requireClientCert);
    }

    private HttpsServer https(Path serverKeyStore, boolean requireClientCert) throws Exception {
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(load(serverKeyStore), PW.toCharArray());
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(load(trustOfClient));
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(kmf.getKeyManagers(), tmf.getTrustManagers(), null);
        HttpsServer s = HttpsServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        s.setHttpsConfigurator(new HttpsConfigurator(ctx) {
            @Override
            public void configure(HttpsParameters params) {
                var cfg = getSSLContext().getDefaultSSLParameters();
                cfg.setNeedClientAuth(requireClientCert);
                params.setSSLParameters(cfg);
            }
        });
        s.createContext("/", ex -> reply(ex, 200, "{\"id\":\"tls\",\"name\":\"secure\"}"));
        s.start();
        servers.add(s);
        return s;
    }

    private static PsoProperties.Remote tlsRemote(HttpServer s, Path trust, Path keyStore) {
        PsoProperties.Remote r = remote("https://127.0.0.1:" + s.getAddress().getPort());
        r.getRetry().setMaxAttempts(1);
        if (trust != null) {
            r.getTls().setTrustStore(trust.toString());
            r.getTls().setTrustStorePassword(PW);
        }
        if (keyStore != null) {
            r.getTls().setKeyStore(keyStore.toString());
            r.getTls().setKeyStorePassword(PW);
        }
        return r;
    }

    @Test
    void tlsWithAConfiguredTrustStoreWorks() throws Exception {
        HttpServer s = https(false);
        assertThat(client(Map.of("secure", tlsRemote(s, trustOfServer, null))).get("secure", "/x", Customer.class).id()).isEqualTo("tls");
    }

    @Test
    void certificateValidationIsNeverDisabled() throws Exception {
        HttpServer s = https(false);
        // default JVM trust: the self-signed certificate is not trusted
        assertThatThrownBy(() -> client(Map.of("secure", tlsRemote(s, null, null))).get("secure", "/x", Customer.class))
            .isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.TLS));
        // a trust store that does not contain the server certificate
        assertThatThrownBy(() -> client(Map.of("secure", tlsRemote(s, otherTrust, null))).get("secure", "/x", Customer.class))
            .isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.TLS));
    }

    @Test
    void mutualTlsRequiresAndUsesTheClientCertificate() throws Exception {
        HttpServer s = https(true);
        assertThat(client(Map.of("secure", tlsRemote(s, trustOfServer, clientKs))).get("secure", "/x", Customer.class).name()).isEqualTo("secure");
        assertThatThrownBy(() -> client(Map.of("secure", tlsRemote(s, trustOfServer, null))).get("secure", "/x", Customer.class))
            .as("no client certificate offered").isInstanceOf(PsoHttpException.class);
    }

    @Test
    void unreadableTlsMaterialFailsAtStartupWithoutLeakingPasswords() {
        PsoProperties.Remote r = remote("https://127.0.0.1:8443");
        r.getTls().setTrustStore(dir.resolve("missing.p12").toString());
        r.getTls().setTrustStorePassword("super-secret-pw");
        assertThatThrownBy(() -> client(Map.of("secure", r))).hasMessageContaining("TLS material could not be loaded").hasMessageNotContaining("super-secret-pw");
    }

    // ------------------------------------------------------------------ PEM material (F-13): the files the orchestrator and `pso tls:init` use

    private static String pem(String type, byte[] der) {
        return "-----BEGIN " + type + "-----\n" + java.util.Base64.getMimeEncoder(64, new byte[] { '\n' }).encodeToString(der) + "\n-----END " + type + "-----\n";
    }

    /** The certificate of a key store entry as a PEM file. */
    private static Path pemCertificate(Path ks, String alias) throws Exception {
        Path f = dir.resolve(alias + "-" + System.nanoTime() + ".cert.pem");
        Files.writeString(f, pem("CERTIFICATE", load(ks).getCertificate(alias).getEncoded()));
        return f;
    }

    /** The private key of a key store entry as an unencrypted PKCS#8 PEM file. */
    private static Path pemKey(Path ks, String alias) throws Exception {
        Path f = dir.resolve(alias + "-" + System.nanoTime() + ".key.pem");
        Files.writeString(f, pem("PRIVATE KEY", load(ks).getKey(alias, PW.toCharArray()).getEncoded()));
        return f;
    }

    private static PsoProperties.Remote pemRemote(HttpServer s, Path caFile) {
        PsoProperties.Remote r = remote("https://127.0.0.1:" + s.getAddress().getPort());
        r.getRetry().setMaxAttempts(1);
        if (caFile != null) {
            r.getTls().setCaFile(caFile.toString());
        }
        return r;
    }

    @Test
    void aPemAuthorityFileIsTrustedWithoutConvertingItToAKeyStore() throws Exception {
        HttpServer s = https(false);
        assertThat(client(Map.of("secure", pemRemote(s, pemCertificate(serverKs, "server")))).get("secure", "/x", Customer.class).id()).isEqualTo("tls");
        // several authorities in one file: the server's is among them
        Path bundle = dir.resolve("bundle.pem");
        Files.writeString(bundle, Files.readString(pemCertificate(clientKs, "client")) + Files.readString(pemCertificate(serverKs, "server")));
        assertThat(client(Map.of("secure", pemRemote(s, bundle))).get("secure", "/x", Customer.class).id()).isEqualTo("tls");
    }

    @Test
    void anAuthorityThatDidNotSignTheServerCertificateIsRefusedWithPemTrustToo() throws Exception {
        HttpServer s = https(false);
        Path unrelated = pemCertificate(clientKs, "client"); // a valid PEM certificate, but not the server's authority
        assertThatThrownBy(() -> client(Map.of("secure", pemRemote(s, unrelated))).get("secure", "/x", Customer.class))
            .isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.TLS));
    }

    @Test
    void aTrustedCertificateForAnotherHostNameIsRefused() throws Exception {
        // the authority is trusted, but the certificate names another host: host name verification is never disabled
        Path otherHost = dir.resolve("other-host.p12");
        keytool("-genkeypair", "-alias", "server", "-keyalg", "RSA", "-keysize", "2048", "-storetype", "PKCS12", "-keystore", otherHost.toString(), "-storepass", PW,
            "-dname", "CN=billing.internal", "-ext", "san=dns:billing.internal", "-validity", "2");
        HttpServer s = https(otherHost, false);
        assertThatThrownBy(() -> client(Map.of("secure", pemRemote(s, pemCertificate(otherHost, "server")))).get("secure", "/x", Customer.class))
            .isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.TLS));
    }

    @Test
    void mutualTlsWorksWithAPemCertificateAndKey() throws Exception {
        HttpServer s = https(true);
        PsoProperties.Remote r = pemRemote(s, pemCertificate(serverKs, "server"));
        r.getTls().setCertFile(pemCertificate(clientKs, "client").toString());
        r.getTls().setKeyFile(pemKey(clientKs, "client").toString());
        assertThat(client(Map.of("secure", r)).get("secure", "/x", Customer.class).name()).isEqualTo("secure");
        assertThatThrownBy(() -> client(Map.of("secure", pemRemote(s, pemCertificate(serverKs, "server")))).get("secure", "/x", Customer.class))
            .as("no client certificate offered").isInstanceOf(PsoHttpException.class);
    }

    @Test
    void pemMaterialIsCheckedAtStartupAndTheProblemIsNamedWithoutLeakingKeys() throws Exception {
        // missing trust material
        PsoProperties.Remote missing = remote("https://127.0.0.1:8443");
        missing.getTls().setCaFile(dir.resolve("missing-ca.pem").toString());
        assertThatThrownBy(() -> client(Map.of("secure", missing))).hasMessageContaining("tls.ca-file not found");
        // a file that holds no certificate
        Path empty = dir.resolve("empty.pem");
        Files.writeString(empty, "not a certificate\n");
        PsoProperties.Remote none = remote("https://127.0.0.1:8443");
        none.getTls().setCaFile(empty.toString());
        assertThatThrownBy(() -> client(Map.of("secure", none))).hasMessageContaining("TLS material could not be loaded").hasMessageContaining("tls.ca-file");
        // an expired authority is named at start-up instead of failing every handshake later
        Path expiredKs = dir.resolve("expired.p12");
        keytool("-genkeypair", "-alias", "old", "-keyalg", "RSA", "-keysize", "2048", "-storetype", "PKCS12", "-keystore", expiredKs.toString(), "-storepass", PW,
            "-dname", "CN=old-authority", "-startdate", "-10d", "-validity", "2");
        PsoProperties.Remote expired = remote("https://127.0.0.1:8443");
        expired.getTls().setCaFile(pemCertificate(expiredKs, "old").toString());
        assertThatThrownBy(() -> client(Map.of("secure", expired))).hasMessageContaining("the certificate authority in").hasMessageContaining("expired on");
        // two ways to say the same thing, and half of a client identity, are configuration errors
        PsoProperties.Remote both = remote("https://127.0.0.1:8443");
        both.getTls().setCaFile(pemCertificate(serverKs, "server").toString());
        both.getTls().setTrustStore(trustOfServer.toString());
        assertThatThrownBy(() -> client(Map.of("secure", both))).hasMessageContaining("tls.ca-file and tls.trust-store");
        PsoProperties.Remote half = remote("https://127.0.0.1:8443");
        half.getTls().setCertFile(pemCertificate(clientKs, "client").toString());
        assertThatThrownBy(() -> client(Map.of("secure", half))).hasMessageContaining("tls.cert-file and tls.key-file must be set together");
        // a key file that is not a key: the message names the file, never its content
        Path badKey = dir.resolve("bad.key.pem");
        Files.writeString(badKey, "-----BEGIN PRIVATE KEY-----\nc2VjcmV0LWtleS1tYXRlcmlhbA==\n-----END PRIVATE KEY-----\n");
        PsoProperties.Remote broken = remote("https://127.0.0.1:8443");
        broken.getTls().setCertFile(pemCertificate(clientKs, "client").toString());
        broken.getTls().setKeyFile(badKey.toString());
        assertThatThrownBy(() -> client(Map.of("secure", broken))).hasMessageContaining("TLS material could not be loaded").hasMessageNotContaining("c2VjcmV0");
    }

    // ------------------------------------------------------------------ service identity, rotation, audience

    @Test
    void theServiceIdentityIsPinnedInAdditionToHostNameVerification() throws Exception {
        HttpServer s = https(false); // certificate: dns:localhost, ip:127.0.0.1
        for (String ok : List.of("localhost", "127.0.0.1")) {
            PsoProperties.Remote r = tlsRemote(s, trustOfServer, null);
            r.getTls().setServerName(ok);
            assertThat(client(Map.of("secure", r)).get("secure", "/x", Customer.class).id()).as("expected identity " + ok).isEqualTo("tls");
        }
        PsoProperties.Remote wrong = tlsRemote(s, trustOfServer, null);
        wrong.getTls().setServerName("billing.internal");
        assertThatThrownBy(() -> client(Map.of("secure", wrong)).get("secure", "/x", Customer.class))
            .as("a certificate that does not carry the expected service identity is refused even though it is trusted")
            .isInstanceOfSatisfying(PsoHttpException.class, e -> assertThat(e.kind()).isEqualTo(Kind.TLS));
    }

    @Test
    void clientCertificatesRotateWithoutARestartAndABrokenReplacementKeepsTheLastGoodOne() throws Exception {
        HttpServer s = https(true); // the server trusts only clientKs
        Path rotating = dir.resolve("rotating-" + System.nanoTime() + ".p12");
        Files.copy(dir.resolve("unrelated.p12"), rotating); // an identity the server does not trust
        PsoProperties.Remote r = tlsRemote(s, trustOfServer, rotating);
        DefaultPsoHttpClient http = client(Map.of("secure", r));
        assertThatThrownBy(() -> http.get("secure", "/x", Customer.class)).as("untrusted client certificate").isInstanceOf(PsoHttpException.class);
        Files.copy(clientKs, rotating, java.nio.file.StandardCopyOption.REPLACE_EXISTING); // the platform rotates the file
        Files.setLastModifiedTime(rotating, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 5000));
        Customer ok = null;
        long end = System.currentTimeMillis() + 10_000;
        while (ok == null && System.currentTimeMillis() < end) {
            Thread.sleep(300);
            try {
                ok = http.get("secure", "/x", Customer.class);
            } catch (PsoHttpException e) {
                // the new material is picked up within about a second
            }
        }
        assertThat(ok).as("the rotated certificate is used without restarting").isNotNull();
        Files.write(rotating, new byte[] {1, 2, 3}); // a corrupt / half-written replacement
        Files.setLastModifiedTime(rotating, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 10_000));
        Thread.sleep(1300);
        assertThat(http.get("secure", "/x", Customer.class).id()).as("the previous material keeps serving").isEqualTo("tls");
    }

    private Jwt jwtWithAudience(Object aud) {
        Map<String, Object> claims = new java.util.HashMap<>(Map.of("sub", "caller"));
        if (aud != null) {
            claims.put("aud", aud);
        }
        return new Jwt("caller-token-value", Instant.now(), Instant.now().plusSeconds(60), Map.of("alg", "none"), claims);
    }

    @Test
    void theTokenIsForwardedOnlyWhenItsAudienceMatchesTheRemote() throws Exception {
        List<String> auth = new CopyOnWriteArrayList<>();
        HttpServer s = serve(ex -> { auth.add(String.valueOf(ex.getRequestHeaders().getFirst("Authorization"))); reply(ex, 200, "{}"); });
        PsoProperties.Remote r = remote(url(s));
        r.setForwardBearer(true);
        r.setAudience("billing-api");
        DefaultPsoHttpClient http = client(Map.of("billing", r));
        for (Object aud : new Object[] {List.of("billing-api", "x"), List.of("other-api"), null}) {
            SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwtWithAudience(aud), java.util.List.of()));
            http.get("billing", "/x", String.class);
        }
        assertThat(auth).as("allowed audience / rejected audience / token without audience").containsExactly("Bearer caller-token-value", "null", "null");
    }
}
