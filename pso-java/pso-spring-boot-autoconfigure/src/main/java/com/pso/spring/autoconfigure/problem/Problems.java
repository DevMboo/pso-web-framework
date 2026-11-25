package com.pso.spring.autoconfigure.problem;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.spring.autoconfigure.web.CorrelationIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.MDC;

/**
 * The PSO error standard (RFC 9457 Problem Details, {@code application/problem+json}), identical to the TypeScript orchestrator.
 * The catalog below must equal {@code fixtures/contracts/problem/catalog.json}; a test fails when either side drifts.
 *
 * <p>Body members, in order: type, title, status, detail, instance, code, correlationId, errors, error (deprecated legacy code).
 * {@code detail} is a fixed safe sentence: never an exception message, a stack, a host path or user input.
 */
public final class Problems {

    public static final String CONTENT_TYPE = "application/problem+json";

    public record Kind(String legacy, int status, String code, String slug, String title, String detail) {
    }

    public record FieldProblem(String field, String message) {
    }

    private static Kind kind(String legacy, int status, String code, String title, String detail) {
        return new Kind(legacy, status, code, code.replaceFirst("^PSO_", "").toLowerCase().replace('_', '-'), title, detail);
    }

    public static final List<Kind> CATALOG = List.of(
        kind("bad_request", 400, "PSO_HTTP_BAD_REQUEST", "Bad request", "The request could not be understood."),
        kind("validation_failed", 400, "PSO_VALIDATION_FAILED", "Validation failed", "The request is not valid; see the errors member."),
        kind("invalid_json", 400, "PSO_HTTP_INVALID_JSON", "Malformed JSON body", "The request body is not valid JSON."),
        kind("malformed_multipart", 400, "PSO_HTTP_MALFORMED_MULTIPART", "Malformed multipart body", "The multipart/form-data body is malformed."),
        kind("request_aborted", 400, "PSO_HTTP_REQUEST_ABORTED", "Request aborted", "The client closed the request before it was complete."),
        kind("unauthorized", 401, "PSO_AUTH_UNAUTHORIZED", "Authentication required", "Valid credentials are required to access this resource."),
        kind("forbidden", 403, "PSO_AUTH_FORBIDDEN", "Access denied", "The authenticated caller is not allowed to perform this operation."),
        kind("not_found", 404, "PSO_HTTP_NOT_FOUND", "Resource not found", "No resource matches the request."),
        kind("conflict", 409, "PSO_HTTP_CONFLICT", "Conflict", "The request conflicts with the current state of the resource."),
        kind("upstream_not_found", 404, "PSO_UPSTREAM_NOT_FOUND", "Resource not found", "A resource this request depends on does not exist in an upstream service."),
        kind("upstream_conflict", 409, "PSO_UPSTREAM_CONFLICT", "Conflict", "An upstream service refused the operation because it conflicts with the current state of a resource."),
        kind("payload_too_large", 413, "PSO_HTTP_PAYLOAD_TOO_LARGE", "Request body too large", "The request body exceeds the configured limit."),
        kind("file_too_large", 413, "PSO_FILE_TOO_LARGE", "File too large", "An uploaded file exceeds the allowed size."),
        kind("method_not_allowed", 405, "PSO_HTTP_METHOD_NOT_ALLOWED", "Method not allowed", "The HTTP method is not supported for this resource."),
        kind("multipart_not_enabled", 415, "PSO_HTTP_MULTIPART_DISABLED", "Multipart not enabled", "Multipart requests are not enabled for this service."),
        kind("unsupported_media_type", 415, "PSO_HTTP_UNSUPPORTED_MEDIA_TYPE", "Unsupported media type", "The request content type is not supported; use application/json."),
        kind("header_fields_too_large", 431, "PSO_HTTP_HEADERS_TOO_LARGE", "Request headers too large", "The request headers exceed the configured limit."),
        kind("too_many_requests", 429, "PSO_RATE_LIMITED", "Too many requests", "The rate limit was exceeded; retry after the interval given in Retry-After."),
        kind("internal_error", 500, "PSO_INTERNAL_ERROR", "Internal error", "The server could not complete the request."),
        kind("upstream_policy", 500, "PSO_UPSTREAM_POLICY", "Upstream call refused by policy", "The outbound call was refused by the destination policy; nothing was sent."),
        kind("bad_gateway", 502, "PSO_UPSTREAM_BAD_GATEWAY", "Bad gateway", "An upstream service returned an invalid response."),
        kind("upstream_rejected", 502, "PSO_UPSTREAM_REJECTED", "Upstream rejected the request", "An upstream service refused a request this service made to complete the operation."),
        kind("upstream_tls", 502, "PSO_UPSTREAM_TLS", "Upstream TLS failure", "The TLS connection to an upstream service could not be established or verified."),
        kind("upstream_response_too_large", 502, "PSO_UPSTREAM_RESPONSE_TOO_LARGE", "Upstream response too large", "An upstream service returned a response larger than the configured limit."),
        kind("unknown_service", 502, "PSO_UPSTREAM_UNKNOWN_SERVICE", "Upstream not configured", "The route refers to an upstream service that is not configured."),
        kind("upstream_unavailable", 503, "PSO_UPSTREAM_UNAVAILABLE", "Upstream unavailable", "An upstream service could not be reached."),
        kind("storage_unavailable", 503, "PSO_STORAGE_UNAVAILABLE", "Storage unavailable", "The file storage backend could not complete the operation."),
        kind("server_busy", 503, "PSO_SERVER_BUSY", "Server busy", "The server is at its concurrency limit; retry shortly."),
        kind("rate_limit_unavailable", 503, "PSO_RATE_LIMIT_UNAVAILABLE", "Rate limiting unavailable", "The shared rate limit backend is unavailable and the policy is to refuse requests."),
        kind("upstream_timeout", 504, "PSO_UPSTREAM_TIMEOUT", "Upstream timeout", "An upstream service did not answer in time."));

    private Problems() {
    }

    public static Kind kind(String legacy) {
        for (Kind k : CATALOG) {
            if (k.legacy().equals(legacy)) {
                return k;
            }
        }
        throw new IllegalArgumentException("unknown problem kind: " + legacy);
    }

    /** The correlation id of the current request (set by the PSO correlation filter), or a fresh one when called outside a request. */
    public static String correlationId() {
        String id = MDC.get(CorrelationIdFilter.MDC_KEY);
        return id != null ? id : UUID.randomUUID().toString();
    }

    /** Request path without query string, safe as a URI reference. */
    public static String instanceOf(String requestPath) {
        if (requestPath == null || requestPath.isBlank()) {
            return null;
        }
        String path = requestPath.split("\\?", 2)[0];
        if (path.length() > 512) {
            path = path.substring(0, 512);
        }
        try {
            return new URI(null, null, path, null).toASCIIString();
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }

    /** Builds the problem body (a plain ordered map, so it serializes identically everywhere). */
    public static Map<String, Object> body(String legacy, int statusIfUnknown, String correlationId, String instancePath, List<FieldProblem> errors, String detailOverride) {
        Map<String, Object> m = new LinkedHashMap<>();
        Kind k = null;
        for (Kind c : CATALOG) {
            if (c.legacy().equals(legacy)) {
                k = c;
            }
        }
        if (k != null) {
            m.put("type", "urn:pso:problem:" + k.slug());
            m.put("title", k.title());
            m.put("status", k.status());
            m.put("detail", detailOverride != null ? detailOverride : k.detail());
        } else { // an application-raised error with its own status
            m.put("type", "urn:pso:problem:http-" + statusIfUnknown);
            m.put("title", "HTTP " + statusIfUnknown);
            m.put("status", statusIfUnknown);
            m.put("detail", detailOverride != null ? detailOverride : legacy);
        }
        String instance = instanceOf(instancePath);
        if (instance != null) {
            m.put("instance", instance);
        }
        m.put("code", k != null ? k.code() : "PSO_HTTP_ERROR_" + statusIfUnknown);
        m.put("correlationId", correlationId);
        if (errors != null && !errors.isEmpty()) {
            m.put("errors", errors.stream().map(e -> {
                Map<String, Object> o = new LinkedHashMap<>();
                if (e.field() != null) {
                    o.put("field", e.field());
                }
                o.put("message", e.message());
                return o;
            }).toList());
        }
        m.put("error", k != null ? k.legacy() : legacy);
        return m;
    }

    public static int statusOf(Map<String, Object> problem) {
        return (Integer) problem.get("status");
    }

    /** Writes a problem from servlet-filter level code (authentication entry point, access denied handler). */
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static void write(HttpServletRequest req, HttpServletResponse res, String legacy) throws IOException {
        write(req, res, legacy, "unauthorized".equals(legacy) ? "Bearer" : null);
    }

    /** As {@link #write(HttpServletRequest, HttpServletResponse, String)} with an explicit WWW-Authenticate challenge (RFC 6750). */
    public static void write(HttpServletRequest req, HttpServletResponse res, String legacy, String wwwAuthenticate) throws IOException {
        Map<String, Object> p = body(legacy, 500, correlationId(), req.getRequestURI(), null, null);
        res.setStatus(statusOf(p));
        res.setContentType(CONTENT_TYPE);
        res.setCharacterEncoding(StandardCharsets.UTF_8.name());
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (wwwAuthenticate != null) {
            res.setHeader("WWW-Authenticate", wwwAuthenticate);
        }
        res.getWriter().write(MAPPER.writeValueAsString(p));
    }
}
