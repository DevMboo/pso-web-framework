package com.pso.spring.storage.web;

import com.pso.spring.autoconfigure.problem.Problems;
import com.pso.spring.storage.StorageException;
import java.util.List;
import java.util.Map;
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
 * Storage failures as PSO problems (RFC 9457). The texts are the fixed catalog texts: a provider exception message (bucket, account,
 * path, request id) never reaches the client; it stays in the server log through the exception's cause.
 */
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE - 150)
public class StorageProblemAdvice {

    private static ResponseEntity<Object> respond(String legacy, int status, WebRequest request, List<Problems.FieldProblem> errors, String detail) {
        String path = request instanceof ServletWebRequest s ? s.getRequest().getRequestURI() : null;
        Map<String, Object> body = Problems.body(legacy, status, Problems.correlationId(), path, errors, detail);
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.parseMediaType(Problems.CONTENT_TYPE));
        h.setCacheControl("no-store");
        return ResponseEntity.status(Problems.statusOf(body)).headers(h).body(body);
    }

    @ExceptionHandler(StorageException.NotFound.class)
    ResponseEntity<Object> notFound(StorageException.NotFound e, WebRequest r) {
        return respond("not_found", 404, r, null, null);
    }

    @ExceptionHandler(StorageException.AccessDenied.class)
    ResponseEntity<Object> denied(StorageException.AccessDenied e, WebRequest r) {
        return respond("forbidden", 403, r, null, null);
    }

    @ExceptionHandler(StorageException.Conflict.class)
    ResponseEntity<Object> conflict(StorageException.Conflict e, WebRequest r) {
        return respond("conflict", 409, r, null, "The file already exists.");
    }

    @ExceptionHandler(StorageException.TooLarge.class)
    ResponseEntity<Object> tooLarge(StorageException.TooLarge e, WebRequest r) {
        return respond("file_too_large", 413, r, null, null);
    }

    @ExceptionHandler(StorageException.Invalid.class)
    ResponseEntity<Object> invalid(StorageException.Invalid e, WebRequest r) {
        return respond("validation_failed", 400, r, e.problems().stream().map(p -> new Problems.FieldProblem(p.field(), p.message())).toList(), null);
    }

    @ExceptionHandler(StorageException.Unavailable.class)
    ResponseEntity<Object> unavailable(StorageException.Unavailable e, WebRequest r) {
        return respond("storage_unavailable", 503, r, null, null);
    }
}
