package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pso.it.app.TestApp;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * OpenTelemetry in a Spring service through the official Micrometer / OpenTelemetry exporters (pso-observability-starter), against a real
 * OTLP/HTTP collector endpoint and a real upstream that records the W3C traceparent it receives.
 */
class ObservabilityTests {

    record Hit(String path, String contentType, byte[] body) {
        boolean contains(String text) {
            return new String(body, StandardCharsets.ISO_8859_1).contains(text);
        }
    }

    static HttpServer server(List<Hit> hits, java.util.function.Consumer<com.sun.net.httpserver.HttpExchange> extra) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        s.createContext("/", ex -> {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            ex.getRequestBody().transferTo(b);
            hits.add(new Hit(ex.getRequestURI().getPath(), String.valueOf(ex.getRequestHeaders().getFirst("Content-Type")), b.toByteArray()));
            if (extra != null) {
                extra.accept(ex);
            }
            byte[] ok = ex.getRequestURI().getPath().startsWith("/v1/") ? new byte[0] : "\"pong\"".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", ex.getRequestURI().getPath().startsWith("/v1/") ? "application/x-protobuf" : "application/json");
            ex.sendResponseHeaders(200, ok.length == 0 ? -1 : ok.length);
            if (ok.length > 0) {
                ex.getResponseBody().write(ok);
            }
            ex.close();
        });
        s.start();
        return s;
    }

    static List<String> props(String... extra) {
        List<String> p = new ArrayList<>(List.of("server.port=0", "spring.main.banner-mode=off", "logging.level.root=WARN", "pso.service.name=obs-service",
            "pso.limits.requests.per-minute=100000", "pso.dispatch.enabled=false",
            "pso.security.jwt.jwks-uri=" + Base.JWT.jwksUri(), "pso.security.jwt.issuer=" + com.pso.test.PsoTestJwt.ISSUER, "pso.security.jwt.audience=" + com.pso.test.PsoTestJwt.AUDIENCE, "pso.security.jwt.algorithms=ES256"));
        p.addAll(List.of(extra));
        return p;
    }

    static int port(ConfigurableApplicationContext c) {
        return ((WebServerApplicationContext) c).getWebServer().getPort();
    }

    static void waitFor(java.util.function.BooleanSupplier c, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean() && System.currentTimeMillis() < end) {
            Thread.sleep(200);
        }
    }

    @Test
    void nothingIsExportedUnlessAnEndpointIsConfigured() throws Exception {
        List<Hit> collected = new CopyOnWriteArrayList<>();
        HttpServer collector = server(collected, null);
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(TestApp.class).properties(props().toArray(new String[0])).run()) {
            assertThat(ctx.getEnvironment().getProperty("management.otlp.metrics.export.enabled")).isEqualTo("false");
            assertThat(ctx.getEnvironment().getProperty("management.otlp.tracing.export.enabled")).isEqualTo("false");
            Http.get(port(ctx), "/actuator/health", null);
            Thread.sleep(2500);
            assertThat(collected).as("no endpoint configured: not one byte leaves the process (a collector on the default port would see it)").isEmpty();
        } finally {
            collector.stop(0);
        }
    }

    @Test
    void tracesAndMetricsAreExportedAndTheTraceContinuesToTheUpstream() throws Exception {
        List<Hit> collected = new CopyOnWriteArrayList<>();
        List<String> upstreamTraceparents = new CopyOnWriteArrayList<>();
        HttpServer collector = server(collected, null);
        HttpServer upstream = server(new CopyOnWriteArrayList<>(), ex -> upstreamTraceparents.add(String.valueOf(ex.getRequestHeaders().getFirst("traceparent"))));
        String endpoint = "http://127.0.0.1:" + collector.getAddress().getPort();
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(TestApp.class).properties(props(
            "OTEL_EXPORTER_OTLP_ENDPOINT=" + endpoint, "PSO_OTEL_EXPORT_INTERVAL_MS=1000", "OTEL_EXPORTER_OTLP_HEADERS=x-api-key=collector-secret",
            "pso.http.client.services.up.base-url=http://127.0.0.1:" + upstream.getAddress().getPort()).toArray(new String[0])).run()) {
            String trace = "4bf92f3577b34da6a3ce929d0e0e4736", callerSpan = "00f067aa0ba902b7";
            var r = Http.send(Http.req(port(ctx), "/obs/trace/call", Base.token()).header("traceparent", "00-" + trace + "-" + callerSpan + "-01").GET());
            assertThat(r.statusCode()).isEqualTo(200);
            waitFor(() -> collected.stream().anyMatch(h -> h.path().equals("/v1/traces")) && collected.stream().anyMatch(h -> h.path().equals("/v1/metrics")), 30_000);
            Hit traces = collected.stream().filter(h -> h.path().equals("/v1/traces")).findFirst().orElseThrow();
            Hit metrics = collected.stream().filter(h -> h.path().equals("/v1/metrics")).findFirst().orElseThrow();
            assertThat(traces.contentType()).contains("protobuf");
            assertThat(traces.contains("obs-service")).as("the resource carries the PSO service name").isTrue();
            assertThat(metrics.contains("obs-service")).isTrue();
            assertThat(metrics.contains("http.server.requests")).as("Spring's own HTTP server metrics are exported").isTrue();
            // the trace continues: the upstream received the caller's trace id with a span id that is NOT the caller's
            assertThat(upstreamTraceparents).isNotEmpty();
            String seen = upstreamTraceparents.get(0);
            assertThat(seen).startsWith("00-" + trace + "-").doesNotContain(callerSpan);
        } finally {
            collector.stop(0);
            upstream.stop(0);
        }
    }

    @Test
    void unsafeEndpointsStopStartup() {
        assertThatThrownBy(() -> new SpringApplicationBuilder(TestApp.class).properties(props("OTEL_EXPORTER_OTLP_ENDPOINT=http://user:pw@collector:4318").toArray(new String[0])).run())
            .hasStackTraceContaining("must not contain credentials");
        assertThatThrownBy(() -> new SpringApplicationBuilder(TestApp.class).properties(props("OTEL_EXPORTER_OTLP_ENDPOINT=ftp://collector").toArray(new String[0])).run())
            .hasStackTraceContaining("must be http:// or https://");
        assertThatThrownBy(() -> new SpringApplicationBuilder(TestApp.class).properties(props("OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318", "PSO_ENV=production").toArray(new String[0])).run())
            .hasStackTraceContaining("must use https://");
    }
}
