package com.pso.spring.storage;

import java.util.List;

/**
 * Failures of the storage API. Messages are safe to log but are never copied to a client: the problem advice answers with the fixed
 * PSO problem texts, and provider exceptions (which can name buckets, accounts or host paths) stay in the cause chain, server side only.
 */
public class StorageException extends RuntimeException {

    public StorageException(String message) {
        super(message);
    }

    public StorageException(String message, Throwable cause) {
        super(message, cause);
    }

    /** No such file or object. */
    public static class NotFound extends StorageException {
        public NotFound(String message) {
            super(message);
        }
    }

    /** The destination already exists; the framework never overwrites silently. */
    public static class Conflict extends StorageException {
        public Conflict(String message) {
            super(message);
        }
    }

    /** The access policy refused the operation. */
    public static class AccessDenied extends StorageException {
        public AccessDenied(String message) {
            super(message);
        }
    }

    /** The content exceeds the configured limit. */
    public static class TooLarge extends StorageException {
        private final long limit;

        public TooLarge(long limit) {
            super("content exceeds the limit of " + limit + " bytes");
            this.limit = limit;
        }

        public long limit() {
            return limit;
        }
    }

    /** The request is not acceptable: bad name, namespace, content type, signature, extension, scanner verdict... */
    public static class Invalid extends StorageException {
        public record Problem(String field, String message) {
        }

        private final List<Problem> problems;

        public Invalid(String field, String message) {
            super(field + " " + message);
            this.problems = List.of(new Problem(field, message));
        }

        public Invalid(List<Problem> problems) {
            super("invalid storage request: " + problems);
            this.problems = List.copyOf(problems);
        }

        public List<Problem> problems() {
            return problems;
        }
    }

    /** The backing store could not complete the operation (network, credentials, throttling, disk). */
    public static class Unavailable extends StorageException {
        public Unavailable(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** True when {@code t} or one of its causes is a {@link StorageException} of the given type (SDKs wrap exceptions thrown by our streams). */
    public static <T extends StorageException> T find(Throwable t, Class<T> type) {
        for (Throwable c = t; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (type.isInstance(c)) {
                return type.cast(c);
            }
        }
        return null;
    }
}
