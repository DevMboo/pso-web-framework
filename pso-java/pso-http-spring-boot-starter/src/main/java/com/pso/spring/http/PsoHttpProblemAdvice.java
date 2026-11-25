package com.pso.spring.http;

import com.pso.spring.autoconfigure.problem.Problems;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;

/**
 * Failures of {@link PsoHttpClient} calls that the application did not handle become PSO problems. The upstream's own message and
 * body are NEVER echoed to the caller; only the kind of failure is reported, mapped exactly like the TypeScript orchestrator maps
 * the failures of its own upstream calls:
 * <ul>
 *   <li>the remote service answered 404 or 409: the same status, as {@code upstream_not_found} / {@code upstream_conflict} (what
 *       those answers usually mean for the caller: something it referred to does not exist, or its change conflicts);</li>
 *   <li>any other 4xx: 502 {@code upstream_rejected} (this service made a request the remote refused; that is not the caller's
 *       400, 401 or 403);</li>
 *   <li>5xx, or an answer that could not be read: 502 {@code bad_gateway};</li>
 *   <li>no answer: 504 {@code upstream_timeout}, 503 {@code upstream_unavailable}, 502 {@code upstream_tls} /
 *       {@code upstream_response_too_large}; refused before anything was sent: 500 {@code upstream_policy}.</li>
 * </ul>
 * An application that knows what a remote answer means catches {@link PsoHttpException} (see {@link PsoHttpException#status()} and
 * {@link PsoHttpException#isStatus(int)}) and raises its own error, for example a {@code ResponseStatusException}.
 */
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE - 100)
public class PsoHttpProblemAdvice {

    private static final Logger LOG = LoggerFactory.getLogger(PsoHttpProblemAdvice.class);

    static String legacyOf(PsoHttpException e) {
        if (e.kind() == PsoHttpException.Kind.REMOTE_CLIENT_ERROR) {
            return e.isStatus(404) ? "upstream_not_found" : e.isStatus(409) ? "upstream_conflict" : "upstream_rejected";
        }
        return legacyOf(e.kind());
    }

    static String legacyOf(PsoHttpException.Kind kind) {
        return switch (kind) {
            case POLICY -> "upstream_policy";
            case TIMEOUT -> "upstream_timeout";
            case CONNECT -> "upstream_unavailable";
            case RESPONSE_TOO_LARGE -> "upstream_response_too_large";
            case TLS -> "upstream_tls";
            case REMOTE_CLIENT_ERROR -> "upstream_rejected";
            default -> "bad_gateway"; // remote 5xx, invalid responses
        };
    }

    @ExceptionHandler(PsoHttpException.class)
    ResponseEntity<Object> upstream(PsoHttpException e, WebRequest request) {
        String legacy = legacyOf(e);
        // the service name and the remote status are for the operator; neither is part of the answer
        LOG.warn("upstream call failed: service={} kind={} remoteStatus={} problem={} correlationId={}", e.service(), e.kind(), e.status() == null ? "-" : e.status(), legacy, Problems.correlationId());
        String path = request instanceof ServletWebRequest s ? s.getRequest().getRequestURI() : null;
        Map<String, Object> body = Problems.body(legacy, Problems.kind(legacy).status(), Problems.correlationId(), path, null, null);
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.parseMediaType(Problems.CONTENT_TYPE));
        h.setCacheControl("no-store");
        return ResponseEntity.status(Problems.statusOf(body)).headers(h).body(body);
    }
}
