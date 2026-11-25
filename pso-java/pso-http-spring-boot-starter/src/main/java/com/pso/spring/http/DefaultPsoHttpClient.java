package com.pso.spring.http;

import com.pso.spring.autoconfigure.PsoProperties;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.function.Supplier;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.TrustManagerFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.client.support.HttpRequestWrapper;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

/**
 * {@link PsoHttpClient} on top of Spring's {@link RestClient} and the JDK {@link HttpClient} (no custom transport). One client per
 * declared service, validated when the application starts, so a bad configuration prevents readiness instead of failing later.
 */
public class DefaultPsoHttpClient implements PsoHttpClient, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(DefaultPsoHttpClient.class);
    private static final Set<HttpMethod> IDEMPOTENT = Set.of(HttpMethod.GET, HttpMethod.HEAD, HttpMethod.PUT, HttpMethod.DELETE, HttpMethod.OPTIONS);

    private final Map<String, Remote> remotes = new LinkedHashMap<>();
    private final ExecutorService async = Executors.newVirtualThreadPerTaskExecutor();
    private final String correlationHeader;

    /**
     * One configured remote service. The HTTP client is rebuilt when its TLS files change (checked at most once per second), so
     * certificates can be rotated without restarting the application; a bad replacement keeps the previous client.
     */
    private static final class Remote {
        private final String name;
        private final PsoProperties.Retry retry;
        private final Supplier<RestClient> factory;
        private final List<String> tlsFiles;
        private volatile RestClient client;
        private volatile String stamp;
        private volatile long checkedAt = System.currentTimeMillis();

        Remote(String name, PsoProperties.Retry retry, Supplier<RestClient> factory, List<String> tlsFiles) {
            this.name = name;
            this.retry = retry;
            this.factory = factory;
            this.tlsFiles = tlsFiles;
            this.client = factory.get(); // an invalid configuration fails here, at start-up
            this.stamp = signature();
        }

        String name() { return name; }

        PsoProperties.Retry retry() { return retry; }

        private String signature() {
            StringBuilder sb = new StringBuilder();
            for (String f : tlsFiles) {
                try {
                    sb.append(f).append(':').append(Files.getLastModifiedTime(Path.of(f)).toMillis()).append(':').append(Files.size(Path.of(f))).append('|');
                } catch (java.io.IOException e) {
                    sb.append(f).append(":missing|");
                }
            }
            return sb.toString();
        }

        RestClient client() {
            if (!tlsFiles.isEmpty()) {
                long now = System.currentTimeMillis();
                if (now - checkedAt >= 1000) {
                    checkedAt = now;
                    String s = signature();
                    if (!s.equals(stamp)) {
                        stamp = s; // retry only on the next change
                        try {
                            client = factory.get();
                            log.info("TLS material of \"{}\" was rotated and is now in use", name);
                        } catch (RuntimeException e) {
                            log.warn("TLS material of \"{}\" changed but is not usable ({}); the previous material stays in use", name, e.getClass().getSimpleName());
                        }
                    }
                }
            }
            return client;
        }
    }

    private final io.micrometer.observation.ObservationRegistry observations;

    public DefaultPsoHttpClient(PsoProperties props) {
        this(props, null);
    }

    /** @param observations when present, every call is observed (client span, http.client.requests, traceparent propagation) */
    public DefaultPsoHttpClient(PsoProperties props, io.micrometer.observation.ObservationRegistry observations) {
        this.observations = observations;
        this.correlationHeader = props.getObservability().getCorrelation().getHeader();
        List<String> problems = new ArrayList<>();
        for (Map.Entry<String, PsoProperties.Remote> e : props.getHttp().getClient().getServices().entrySet()) {
            try {
                remotes.put(e.getKey(), build(e.getKey(), e.getValue()));
            } catch (IllegalArgumentException | IllegalStateException ex) {
                problems.add("pso.http.client.services." + e.getKey() + ": " + ex.getMessage());
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Invalid PSO HTTP client configuration:\n - " + String.join("\n - ", problems));
        }
    }

    // ------------------------------------------------------------------ configuration

    private Remote build(String name, PsoProperties.Remote cfg) {
        if (!name.matches("^[A-Za-z][A-Za-z0-9_-]*$")) {
            throw new IllegalArgumentException("service names use letters, digits, - and _");
        }
        URI base = parseBase(cfg);
        if (cfg.getConnectTimeout().isNegative() || cfg.getConnectTimeout().isZero() || cfg.getReadTimeout().isNegative() || cfg.getReadTimeout().isZero()) {
            throw new IllegalArgumentException("timeouts must be positive");
        }
        long max = cfg.getMaxResponseSize().toBytes();
        if (max <= 0) {
            throw new IllegalArgumentException("max-response-size must be positive");
        }
        boolean https = "https".equals(base.getScheme());
        boolean secureTransport = https || isLoopback(base.getHost());
        String audience = blank(cfg.getAudience()) ? null : cfg.getAudience();
        Supplier<RestClient> factory = () -> {
            HttpClient.Builder hb = HttpClient.newBuilder().connectTimeout(cfg.getConnectTimeout()).followRedirects(HttpClient.Redirect.NEVER);
            if (https) {
                SSLContext ssl = sslContext(cfg.getTls());
                if (ssl != null) {
                    hb.sslContext(ssl);
                }
            }
            JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(hb.build());
            requestFactory.setReadTimeout(cfg.getReadTimeout());
            RestClient.Builder rb = RestClient.builder();
            if (observations != null) {
                rb.observationRegistry(observations);
            }
            return rb
                .baseUrl(base.toString())
                .requestFactory(requestFactory)
                .requestInterceptor(responseLimit(name, max))
                .requestInterceptor(propagation(name, cfg.isForwardBearer(), audience, secureTransport))
                .build();
        };
        return new Remote(name, cfg.getRetry(), factory, https ? tlsFiles(cfg.getTls()) : List.of());
    }

    private static boolean isLoopback(String host) {
        String h = host.replaceAll("^\\[|\\]$", "").toLowerCase();
        return h.equals("localhost") || h.equals("::1") || h.startsWith("127.");
    }

    private static List<String> tlsFiles(PsoProperties.Tls tls) {
        List<String> files = new ArrayList<>();
        for (String f : new String[] { tls.getCaFile(), tls.getCertFile(), tls.getKeyFile(), tls.getTrustStore(), tls.getKeyStore() }) {
            if (!blank(f)) {
                files.add(f);
            }
        }
        return files;
    }

    private static URI parseBase(PsoProperties.Remote cfg) {
        if (cfg.getBaseUrl() == null || cfg.getBaseUrl().isBlank()) {
            throw new IllegalArgumentException("base-url is required");
        }
        URI u;
        try {
            u = new URI(cfg.getBaseUrl().replaceAll("/+$", ""));
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("base-url is not a valid URL");
        }
        if (u.getHost() == null || u.getScheme() == null || !(u.getScheme().equals("http") || u.getScheme().equals("https"))) {
            throw new IllegalArgumentException("base-url must be an absolute http(s) URL");
        }
        if (u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null) {
            throw new IllegalArgumentException("base-url must not contain credentials, a query or a fragment");
        }
        boolean loopback = u.getHost().equals("localhost") || u.getHost().equals("127.0.0.1") || u.getHost().equals("[::1]");
        if (u.getScheme().equals("http") && !loopback && !cfg.isAllowInsecureHttp()) {
            throw new IllegalArgumentException("plain http is refused for non-loopback hosts; use https (or set allow-insecure-http for a trusted network)");
        }
        return u;
    }

    /**
     * Trusted authorities and the client identity for mutual TLS, from PEM files (ca-file, cert-file + key-file: the format the
     * orchestrator, the JWKS authority and `pso tls:init` use) or from key stores (trust-store, key-store: PKCS12 or JKS).
     * Either form only says what is trusted and what is presented: certificate and host name verification stay on (JDK defaults).
     */
    private static SSLContext sslContext(PsoProperties.Tls tls) {
        boolean pemTrust = !blank(tls.getCaFile());
        boolean pemKey = !blank(tls.getCertFile()) || !blank(tls.getKeyFile());
        if (pemTrust && !blank(tls.getTrustStore())) {
            throw new IllegalArgumentException("tls.ca-file and tls.trust-store both name the trusted authorities: set one of them");
        }
        if (pemKey && !blank(tls.getKeyStore())) {
            throw new IllegalArgumentException("tls.cert-file/tls.key-file and tls.key-store both name the client certificate: set one of them");
        }
        if (blank(tls.getCertFile()) != blank(tls.getKeyFile())) {
            throw new IllegalArgumentException("tls.cert-file and tls.key-file must be set together (mutual TLS needs both)");
        }
        if (!pemTrust && !pemKey && blank(tls.getTrustStore()) && blank(tls.getKeyStore()) && blank(tls.getServerName())) {
            return null;
        }
        try {
            TrustManagerFactory tmf = null;
            if (pemTrust || !blank(tls.getTrustStore()) || !blank(tls.getServerName())) {
                tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                tmf.init(pemTrust ? PemMaterial.trustStore(tls.getCaFile())
                    : blank(tls.getTrustStore()) ? (KeyStore) null : load(tls.getTrustStore(), tls.getTrustStoreType(), tls.getTrustStorePassword()));
            }
            KeyManagerFactory kmf = null;
            if (pemKey) {
                kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
                kmf.init(PemMaterial.keyStore(tls.getCertFile(), tls.getKeyFile(), tls.getKeyPassword()), new char[0]);
            } else if (!blank(tls.getKeyStore())) {
                kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
                kmf.init(load(tls.getKeyStore(), tls.getKeyStoreType(), tls.getKeyStorePassword()), password(tls.getKeyStorePassword()));
            }
            SSLContext ctx = SSLContext.getInstance("TLS");
            javax.net.ssl.TrustManager[] trust = tmf == null ? null : tmf.getTrustManagers();
            if (trust != null && !blank(tls.getServerName())) {
                trust = ServiceIdentity.pin(trust, tls.getServerName());
            }
            ctx.init(kmf == null ? null : kmf.getKeyManagers(), trust, null);
            return ctx;
        } catch (PemMaterial.PemException e) {
            // these messages name the file and the reason and nothing else
            throw new IllegalStateException("TLS material could not be loaded: " + e.getMessage());
        } catch (Exception e) {
            // never include passwords or file contents; the cause class is enough to diagnose
            throw new IllegalStateException("TLS material could not be loaded (" + e.getClass().getSimpleName() + "): check tls.trust-store / tls.key-store paths, types and passwords");
        }
    }

    private static KeyStore load(String file, String type, String password) throws Exception {
        KeyStore ks = KeyStore.getInstance(type);
        try (InputStream in = Files.newInputStream(Path.of(file))) {
            ks.load(in, password(password));
        }
        return ks;
    }

    private static char[] password(String p) {
        return p == null ? new char[0] : p.toCharArray();
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    // ------------------------------------------------------------------ interceptors

    private ClientHttpRequestInterceptor responseLimit(String service, long max) {
        return (request, body, execution) -> {
            ClientHttpResponse response = execution.execute(request, body);
            long declared = response.getHeaders().getContentLength();
            if (declared > max) {
                response.close();
                throw tooLarge(service);
            }
            return new ClientHttpResponse() {
                @Override public org.springframework.http.HttpStatusCode getStatusCode() throws IOException { return response.getStatusCode(); }
                @Override public String getStatusText() throws IOException { return response.getStatusText(); }
                @Override public void close() { response.close(); }
                @Override public HttpHeaders getHeaders() { return response.getHeaders(); }
                @Override public InputStream getBody() throws IOException { return new Bounded(response.getBody(), max, service); }
            };
        };
    }

    private static PsoHttpException tooLarge(String service) {
        return new PsoHttpException(service, PsoHttpException.Kind.RESPONSE_TOO_LARGE, null, "response from \"" + service + "\" exceeds the configured max-response-size", null);
    }

    private static final class Bounded extends FilterInputStream {
        private final long max;
        private final String service;
        private long read;

        Bounded(InputStream in, long max, String service) {
            super(in);
            this.max = max;
            this.service = service;
        }

        private void count(long n) {
            if (n > 0 && (read += n) > max) {
                throw tooLarge(service);
            }
        }

        @Override public int read() throws IOException { int b = super.read(); if (b >= 0) { count(1); } return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException { int n = super.read(b, off, len); count(n); return n; }
    }

    /** Correlation id from the current request, and the caller's bearer token ONLY for services configured to receive it. */
    private ClientHttpRequestInterceptor propagation(String service, boolean forwardBearer, String audience, boolean secureTransport) {
        return (request, body, execution) -> {
            HttpRequestWrapper wrapped = new HttpRequestWrapper(request);
            String correlation = MDC.get("correlationId");
            if (correlation != null && !wrapped.getHeaders().containsKey(correlationHeader)) {
                wrapped.getHeaders().set(correlationHeader, correlation);
            }
            if (forwardBearer) {
                String token = BearerSource.currentToken();
                if (token != null) {
                    String refused = BearerPolicy.refusal(secureTransport, audience, BearerSource.currentAudiences());
                    if (refused != null) {
                        log.warn("bearer token not forwarded to \"{}\": {}", service, refused);
                    } else {
                        wrapped.getHeaders().setBearerAuth(token);
                    }
                }
            }
            return execution.execute(wrapped, body);
        };
    }

    // ------------------------------------------------------------------ API

    @Override public <T> T get(String service, String path, Class<T> type, Object... vars) { return exchange(PsoRequest.of(HttpMethod.GET, service, path, vars), type); }
    @Override public <T> T post(String service, String path, Object body, Class<T> type, Object... vars) { return exchange(PsoRequest.of(HttpMethod.POST, service, path, vars).body(body), type); }
    @Override public <T> T put(String service, String path, Object body, Class<T> type, Object... vars) { return exchange(PsoRequest.of(HttpMethod.PUT, service, path, vars).body(body), type); }
    @Override public <T> T patch(String service, String path, Object body, Class<T> type, Object... vars) { return exchange(PsoRequest.of(HttpMethod.PATCH, service, path, vars).body(body), type); }
    @Override public void delete(String service, String path, Object... vars) { exchange(PsoRequest.of(HttpMethod.DELETE, service, path, vars), Void.class); }

    @Override
    public <T> Future<T> exchangeAsync(PsoRequest request, Class<T> type) {
        // the security context and MDC are thread-local: carry them into the worker so bearer forwarding and correlation still work
        var context = BearerSource.captureContext();
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        return async.submit(() -> {
            if (mdc != null) {
                MDC.setContextMap(mdc);
            }
            try (var scope = BearerSource.restore(context)) {
                return exchange(request, type);
            } finally {
                MDC.clear();
            }
        });
    }

    @Override
    public <T> T exchange(PsoRequest req, Class<T> type) {
        Remote remote = remotes.get(req.service());
        if (remote == null) {
            throw new PsoHttpException(String.valueOf(req.service()), PsoHttpException.Kind.POLICY, null,
                "unknown service \"" + req.service() + "\": declare it under pso.http.client.services", null);
        }
        String problem = pathProblem(req.path());
        if (problem != null) {
            throw new PsoHttpException(remote.name(), PsoHttpException.Kind.POLICY, null, "refused path for \"" + remote.name() + "\": " + problem, null);
        }
        int attempts = retryable(remote.retry(), req) ? remote.retry().getMaxAttempts() : 1;
        PsoHttpException last = null;
        for (int attempt = 1; attempt <= attempts; attempt++) {
            try {
                return once(remote, req, type);
            } catch (PsoHttpException e) {
                last = e;
                if (attempt == attempts || !transientFailure(e)) {
                    throw e;
                }
                log.debug("retrying {} {} (attempt {} of {}) after {}", req.method(), remote.name(), attempt + 1, attempts, e.kind());
                pause(remote, remote.retry().getBackoff().multipliedBy(attempt));
            }
        }
        throw last;
    }

    private <T> T once(Remote remote, PsoRequest req, Class<T> type) {
        try {
            RestClient.RequestBodySpec spec = remote.client().method(req.method()).uri(req.path(), req.uriVariables());
            req.headers().forEach(spec::header);
            if (req.body() != null) {
                spec.body(req.body());
            }
            RestClient.ResponseSpec response = spec.retrieve();
            return type == Void.class ? voidResult(response) : response.body(type);
        } catch (PsoHttpException e) {
            throw e;
        } catch (RestClientResponseException e) {
            int status = e.getStatusCode().value();
            PsoHttpException.Kind kind = status >= 500 ? PsoHttpException.Kind.REMOTE_SERVER_ERROR : PsoHttpException.Kind.REMOTE_CLIENT_ERROR;
            throw new PsoHttpException(remote.name(), kind, status, "\"" + remote.name() + "\" answered HTTP " + status, null);
        } catch (ResourceAccessException e) {
            throw map(remote.name(), e);
        } catch (org.springframework.web.client.RestClientException e) {
            throw new PsoHttpException(remote.name(), PsoHttpException.Kind.INVALID_RESPONSE, null, "invalid response from \"" + remote.name() + "\"", null);
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T voidResult(RestClient.ResponseSpec response) {
        response.toBodilessEntity();
        return (T) null;
    }

    private static PsoHttpException map(String service, ResourceAccessException e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof PsoHttpException p) {
                return p;
            }
            if (t instanceof SSLException) {
                return new PsoHttpException(service, PsoHttpException.Kind.TLS, null, "TLS failure talking to \"" + service + "\" (certificate or handshake rejected)", null);
            }
            if (t instanceof HttpConnectTimeoutException || t instanceof HttpTimeoutException || t instanceof java.net.SocketTimeoutException) {
                return new PsoHttpException(service, PsoHttpException.Kind.TIMEOUT, null, "timeout talking to \"" + service + "\"", null);
            }
            if (t instanceof InterruptedException) {
                Thread.currentThread().interrupt();
                return new PsoHttpException(service, PsoHttpException.Kind.CANCELLED, null, "call to \"" + service + "\" was cancelled", null);
            }
            if (t instanceof ConnectException) {
                return new PsoHttpException(service, PsoHttpException.Kind.CONNECT, null, "cannot connect to \"" + service + "\"", null);
            }
        }
        return new PsoHttpException(service, PsoHttpException.Kind.CONNECT, null, "I/O failure talking to \"" + service + "\"", null);
    }

    // ------------------------------------------------------------------ policy helpers

    /** Paths are relative: no scheme or authority, no dot segments, no encoded traversal. @return the reason, or null when acceptable */
    static String pathProblem(String path) {
        if (path == null || !path.startsWith("/")) {
            return "must start with /";
        }
        if (path.startsWith("//") || path.contains("://") || path.contains("\\") || path.contains("\r") || path.contains("\n")) {
            return "must be a plain path, not a URL";
        }
        String lower = path.toLowerCase();
        if (lower.contains("/../") || lower.endsWith("/..") || lower.contains("/./") || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c")) {
            return "dot segments and encoded separators are not allowed";
        }
        return null;
    }

    private static boolean retryable(PsoProperties.Retry retry, PsoRequest req) {
        if (retry.getMaxAttempts() <= 1) {
            return false;
        }
        if (IDEMPOTENT.contains(req.method())) {
            return true;
        }
        return retry.isRetryNonIdempotent() && req.headers().keySet().stream().anyMatch(h -> h.equalsIgnoreCase("Idempotency-Key"));
    }

    private static boolean transientFailure(PsoHttpException e) {
        return switch (e.kind()) {
            case CONNECT, TIMEOUT -> true;
            case REMOTE_SERVER_ERROR -> e.status() != null && (e.status() == 502 || e.status() == 503 || e.status() == 504);
            default -> false;
        };
    }

    private void pause(Remote remote, Duration base) {
        long jitter = ThreadLocalRandom.current().nextLong(Math.max(1, base.toMillis() / 2));
        try {
            Thread.sleep(base.toMillis() + jitter);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PsoHttpException(remote.name(), PsoHttpException.Kind.CANCELLED, null, "call to \"" + remote.name() + "\" was cancelled", e);
        }
    }

    @Override
    public void destroy() {
        async.shutdownNow();
    }
}
