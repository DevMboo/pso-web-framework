package com.pso.spring.autoconfigure.problem;

import org.springframework.http.HttpStatusCode;
import org.springframework.web.server.ResponseStatusException;

/**
 * An error the application raises on purpose, answered as a PSO problem (RFC 9457) with a catalog kind and a safe detail sentence:
 *
 * <pre>{@code
 * throw new PsoProblemException(HttpStatus.CONFLICT, "conflict", "A product with SKU ABC-123 already exists");
 * }</pre>
 *
 * <p>{@code kind} is a catalog kind ({@code not_found}, {@code conflict}, {@code bad_request}, ...) or a short code of your own. The
 * {@code detail} is exposed to the caller: it must be a sentence you wrote, never an exception message or raw user input.
 * The same contract as {@code HttpError(status, kind, { detail })} in the TypeScript orchestrator.
 */
public class PsoProblemException extends ResponseStatusException {

    private final String problemDetail;

    public PsoProblemException(HttpStatusCode status, String kind, String detail) {
        super(status, kind);
        this.problemDetail = detail;
    }

    /** The safe, caller-facing explanation (may be null: the catalog's sentence is used). */
    public String problemDetail() {
        return problemDetail;
    }
}
