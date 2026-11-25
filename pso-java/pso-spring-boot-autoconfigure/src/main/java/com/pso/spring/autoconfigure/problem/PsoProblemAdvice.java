package com.pso.spring.autoconfigure.problem;

import com.pso.spring.autoconfigure.problem.Problems.FieldProblem;
import jakarta.validation.ConstraintViolationException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.lang.Nullable;
import org.springframework.validation.BindException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * The framework-owned error handler: every MVC failure becomes a PSO problem (RFC 9457, same shape as the TypeScript orchestrator).
 * Exception messages, stack traces and user input never reach the response; the exception CLASS and the correlation id are logged.
 * An application can still add its own {@code @ExceptionHandler} for its domain exceptions (higher precedence than this advice) or replace
 * this bean entirely by defining its own {@code PsoProblemAdvice}.
 */
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE)
public class PsoProblemAdvice extends ResponseEntityExceptionHandler {

    private static final Logger LOG = LoggerFactory.getLogger(PsoProblemAdvice.class);

    private final boolean errorDetails;

    public PsoProblemAdvice() {
        this(false);
    }

    /**
     * @param errorDetails log the message and the stack trace of an unexpected exception (pso.observability.error-details outside
     *        production). The exception class, the place it came from and the correlation id are logged either way.
     */
    public PsoProblemAdvice(boolean errorDetails) {
        this.errorDetails = errorDetails;
    }

    /** The first stack frame that is application code: "Class.method(File.java:line)". Says where, never what. */
    static String origin(Throwable ex) {
        StackTraceElement[] stack = ex.getStackTrace();
        for (StackTraceElement f : stack) {
            String c = f.getClassName();
            if (!(c.startsWith("java.") || c.startsWith("javax.") || c.startsWith("jakarta.") || c.startsWith("jdk.") || c.startsWith("sun.")
                || c.startsWith("org.springframework.") || c.startsWith("org.apache.") || c.startsWith("com.pso.spring.") || c.startsWith("com.pso.dispatch."))) {
                return f.toString();
            }
        }
        return stack.length > 0 ? stack[0].toString() : "unknown";
    }

    private static ResponseEntity<Object> problem(Map<String, Object> body, HttpHeaders extra) {
        HttpHeaders h = new HttpHeaders();
        if (extra != null) {
            h.putAll(extra);
        }
        h.remove(HttpHeaders.CONTENT_LENGTH);
        h.setContentType(MediaType.parseMediaType(Problems.CONTENT_TYPE));
        h.setCacheControl("no-store");
        return ResponseEntity.status(Problems.statusOf(body)).headers(h).body(body);
    }

    static String path(WebRequest request) {
        return request instanceof ServletWebRequest s ? s.getRequest().getRequestURI() : null;
    }

    private static String classify(Exception ex, HttpStatusCode status) {
        // the request-size limiter throws ResponseStatusException(413) from inside the stream; Spring wraps it while reading the body
        for (Throwable t = ex; t != null && t.getCause() != t; t = t.getCause()) {
            if (t instanceof org.springframework.web.server.ResponseStatusException rse && rse.getStatusCode().value() == 413) {
                return "payload_too_large";
            }
        }
        if (ex instanceof MethodArgumentNotValidException || ex instanceof BindException || ex instanceof ConstraintViolationException
            || ex instanceof org.springframework.web.method.annotation.HandlerMethodValidationException) {
            return "validation_failed";
        }
        if (ex instanceof HttpMessageNotReadableException) {
            return "invalid_json";
        }
        if (ex instanceof HttpMediaTypeNotSupportedException) {
            return "unsupported_media_type";
        }
        if (ex instanceof HttpRequestMethodNotSupportedException) {
            return "method_not_allowed";
        }
        if (ex instanceof NoResourceFoundException || ex instanceof org.springframework.web.servlet.NoHandlerFoundException) {
            return "not_found";
        }
        if (ex instanceof MaxUploadSizeExceededException) {
            return "payload_too_large";
        }
        if (ex instanceof org.springframework.web.server.ResponseStatusException rse && status.is4xxClientError()) {
            // an error the application raised deliberately (ResponseStatusException): 404 is the catalog's not_found; any other 4xx keeps
            // its own status and exposes the reason the application chose, exactly like HttpError in the Node orchestrator
            if (status.value() == 404 && !(ex instanceof PsoProblemException)) {
                return "not_found";
            }
            return rse.getReason() != null && !rse.getReason().isBlank() ? rse.getReason() : "http_" + status.value();
        }
        return status.is4xxClientError() ? "bad_request" : "internal_error";
    }

    private static int statusOf(String legacy, HttpStatusCode status) {
        try {
            return Problems.kind(legacy).status();
        } catch (IllegalArgumentException unknownKind) {
            return status.value();
        }
    }

    private static List<FieldProblem> errorsOf(Exception ex) {
        List<FieldProblem> out = new ArrayList<>();
        if (ex instanceof BindException b) { // MethodArgumentNotValidException extends BindException
            b.getBindingResult().getFieldErrors().forEach(f -> out.add(new FieldProblem(f.getField(), f.getDefaultMessage() == null ? "invalid" : f.getDefaultMessage())));
            b.getBindingResult().getGlobalErrors().forEach(g -> out.add(new FieldProblem(null, g.getDefaultMessage() == null ? "invalid" : g.getDefaultMessage())));
        } else if (ex instanceof ConstraintViolationException c) {
            c.getConstraintViolations().forEach(v -> out.add(new FieldProblem(v.getPropertyPath().toString(), v.getMessage())));
        }
        return out;
    }

    @Override
    protected ResponseEntity<Object> handleExceptionInternal(Exception ex, @Nullable Object body, HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        String legacy = classify(ex, status);
        int code = statusOf(legacy, status);
        if (code >= 500) {
            LOG.warn("request failed: {} correlationId={}", ex.getClass().getSimpleName(), Problems.correlationId());
        }
        // an application-raised PsoProblemException carries a safe sentence of its own; nothing else ever overrides the catalog detail
        String detail = ex instanceof PsoProblemException ppe ? ppe.problemDetail() : null;
        Map<String, Object> p = Problems.body(legacy, code, Problems.correlationId(), path(request), errorsOf(ex), detail);
        if ("validation_failed".equals(legacy)) { // deprecated shape kept for clients of the former template handler
            java.util.Map<String, String> fields = new java.util.LinkedHashMap<>();
            errorsOf(ex).forEach(e -> { if (e.field() != null) fields.put(e.field(), e.message()); });
            if (!fields.isEmpty()) {
                p.put("fields", fields);
            }
        }
        return problem(p, headers);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    ResponseEntity<Object> constraint(ConstraintViolationException ex, WebRequest request) {
        return handleExceptionInternal(ex, null, new HttpHeaders(), org.springframework.http.HttpStatus.BAD_REQUEST, request);
    }

    /**
     * Last resort: anything unexpected is a generic 500; nothing about the failure is returned. The log names the exception class,
     * the application code it came from and the correlation id in every environment; with error details (development) it also
     * carries the message and the stack trace.
     */
    @ExceptionHandler(Exception.class)
    ResponseEntity<Object> unexpected(Exception ex, WebRequest request) {
        if (errorDetails) {
            LOG.error("unhandled exception: {} correlationId={} origin={} path={}", ex.getClass().getName(), Problems.correlationId(), origin(ex), path(request), ex);
        } else {
            LOG.error("unhandled exception: {} correlationId={} origin={} path={}", ex.getClass().getName(), Problems.correlationId(), origin(ex), path(request));
        }
        return problem(Problems.body("internal_error", 500, Problems.correlationId(), path(request), null, null), null);
    }
}
