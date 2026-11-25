package com.pso.spring.http;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpMethod;

/** A request to a NAMED service. The path is relative to that service's configured base URL; a full URL is never accepted. */
public final class PsoRequest {

    private final HttpMethod method;
    private final String service;
    private final String path;
    private final Object[] uriVariables;
    private Object body;
    private final Map<String, String> headers = new LinkedHashMap<>();

    private PsoRequest(HttpMethod method, String service, String path, Object[] uriVariables) {
        this.method = method;
        this.service = service;
        this.path = path;
        this.uriVariables = uriVariables == null ? new Object[0] : uriVariables.clone();
    }

    public static PsoRequest of(HttpMethod method, String service, String path, Object... uriVariables) {
        return new PsoRequest(method, service, path, uriVariables);
    }

    public PsoRequest body(Object body) {
        this.body = body;
        return this;
    }

    public PsoRequest header(String name, String value) {
        this.headers.put(name, value);
        return this;
    }

    /** Marks the request as safe to repeat; required (together with retry.retry-non-idempotent) before POST or PATCH is retried. */
    public PsoRequest idempotencyKey(String key) {
        return header("Idempotency-Key", key);
    }

    HttpMethod method() { return method; }
    String service() { return service; }
    String path() { return path; }
    Object[] uriVariables() { return uriVariables; }
    Object body() { return body; }
    Map<String, String> headers() { return headers; }
}
