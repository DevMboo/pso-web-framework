package com.pso.spring.security;

import com.pso.spring.autoconfigure.problem.Problems;
import java.util.Map;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;

/**
 * Security failures raised INSIDE a controller (method security: {@code @PreAuthorize}) are 401/403 problems, not 500s. Failures raised by
 * the filter chain are handled by the entry point and access-denied handler configured in {@link PsoSecurityAutoConfiguration}.
 */
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE - 200)
public class PsoSecurityProblemAdvice {

    private static ResponseEntity<Object> respond(String legacy, WebRequest request, String challenge) {
        String path = request instanceof ServletWebRequest s ? s.getRequest().getRequestURI() : null;
        Map<String, Object> body = Problems.body(legacy, Problems.kind(legacy).status(), Problems.correlationId(), path, null, null);
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.parseMediaType(Problems.CONTENT_TYPE));
        h.setCacheControl("no-store");
        if (challenge != null) {
            h.set(HttpHeaders.WWW_AUTHENTICATE, challenge);
        }
        return ResponseEntity.status(Problems.statusOf(body)).headers(h).body(body);
    }

    @ExceptionHandler(AccessDeniedException.class)
    ResponseEntity<Object> denied(AccessDeniedException e, WebRequest request) {
        return respond("forbidden", request, null);
    }

    @ExceptionHandler(AuthenticationException.class)
    ResponseEntity<Object> unauthenticated(AuthenticationException e, WebRequest request) {
        return respond("unauthorized", request, "Bearer");
    }
}
