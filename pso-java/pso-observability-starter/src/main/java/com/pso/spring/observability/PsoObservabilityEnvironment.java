package com.pso.spring.observability;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Maps the standard OpenTelemetry variables onto Spring Boot's own OTLP properties, at the LOWEST precedence (an explicit
 * {@code management.otlp.*} property always wins). Nothing is exported unless an endpoint is configured: without
 * {@code OTEL_EXPORTER_OTLP_ENDPOINT} both OTLP exporters are switched OFF (Boot would otherwise push to localhost:4318 by default).
 * Tracing itself stays on, so W3C {@code traceparent} is still propagated and trace ids still appear in logs.
 */
public class PsoObservabilityEnvironment implements EnvironmentPostProcessor, Ordered {

    static final String SOURCE = "psoObservabilityDefaults";

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication application) {
        if (env.getPropertySources().contains(SOURCE)) {
            return;
        }
        Map<String, Object> p = new LinkedHashMap<>();
        String endpoint = trim(env.getProperty("OTEL_EXPORTER_OTLP_ENDPOINT"));
        String service = env.getProperty("OTEL_SERVICE_NAME", env.getProperty("pso.service.name", env.getProperty("spring.application.name", "service")));
        p.put("management.opentelemetry.resource-attributes.service.name", service);
        p.put("management.opentelemetry.resource-attributes.service.namespace", "pso");
        p.put("management.tracing.sampling.probability", env.getProperty("PSO_TRACING_SAMPLING", "1.0"));
        if (endpoint == null) {
            p.put("management.otlp.metrics.export.enabled", "false");
            p.put("management.otlp.tracing.export.enabled", "false");
        } else {
            validate(endpoint, env);
            p.put("management.otlp.metrics.export.enabled", "true");
            p.put("management.otlp.metrics.export.url", endpoint + "/v1/metrics");
            p.put("management.otlp.tracing.export.enabled", "true");
            p.put("management.otlp.tracing.endpoint", endpoint + "/v1/traces");
            String interval = env.getProperty("PSO_OTEL_EXPORT_INTERVAL_MS");
            if (interval != null && interval.matches("\\d{3,6}")) {
                p.put("management.otlp.metrics.export.step", "PT" + Math.max(1, Integer.parseInt(interval) / 1000) + "S");
            }
            for (String part : env.getProperty("OTEL_EXPORTER_OTLP_HEADERS", "").split(",")) {
                int i = part.indexOf('=');
                if (i > 0) {
                    String name = part.substring(0, i).trim();
                    if (!name.matches("[A-Za-z0-9-]+")) {
                        throw new IllegalStateException("OTEL_EXPORTER_OTLP_HEADERS must look like name=value,name2=value2");
                    }
                    p.put("management.otlp.metrics.export.headers." + name, part.substring(i + 1).trim());
                    p.put("management.otlp.tracing.headers." + name, part.substring(i + 1).trim());
                }
            }
        }
        env.getPropertySources().addLast(new MapPropertySource(SOURCE, p));
    }

    private static String trim(String s) {
        return s == null || s.isBlank() ? null : s.trim().replaceAll("/+$", "");
    }

    private static void validate(String endpoint, ConfigurableEnvironment env) {
        java.net.URI u;
        try {
            u = java.net.URI.create(endpoint);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL");
        }
        if (u.getHost() == null || !(u.getScheme().equals("http") || u.getScheme().equals("https"))) {
            throw new IllegalStateException("OTEL_EXPORTER_OTLP_ENDPOINT must be http:// or https://");
        }
        if (u.getUserInfo() != null) {
            throw new IllegalStateException("OTEL_EXPORTER_OTLP_ENDPOINT must not contain credentials; use OTEL_EXPORTER_OTLP_HEADERS");
        }
        boolean production = "production".equals(env.getProperty("PSO_ENV", env.getProperty("NODE_ENV", "")));
        boolean local = u.getHost().equals("localhost") || u.getHost().startsWith("127.") || u.getHost().equals("[::1]");
        if (production && u.getScheme().equals("http") && !local) {
            throw new IllegalStateException("in production a remote OTLP endpoint must use https://");
        }
    }

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }
}
