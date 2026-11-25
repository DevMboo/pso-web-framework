package com.pso.spring.http;

/**
 * Failure of an outbound call. The message is safe to log and to show: it names the service and the kind of failure, never the
 * full URL, query string, headers, tokens or the remote response body.
 */
public class PsoHttpException extends RuntimeException {

    public enum Kind {
        /** The destination is not allowed: unknown service name or an unsafe path. Nothing was sent. */
        POLICY,
        CONNECT,
        TIMEOUT,
        TLS,
        RESPONSE_TOO_LARGE,
        /** The remote service answered 4xx. Not retried. */
        REMOTE_CLIENT_ERROR,
        /** The remote service answered 5xx. */
        REMOTE_SERVER_ERROR,
        CANCELLED,
        /** The response could not be converted to the requested type. */
        INVALID_RESPONSE
    }

    private final String service;
    private final Kind kind;
    private final Integer status;

    public PsoHttpException(String service, Kind kind, Integer status, String message, Throwable cause) {
        super(message, cause);
        this.service = service;
        this.kind = kind;
        this.status = status;
    }

    public String service() { return service; }
    public Kind kind() { return kind; }
    /** The remote HTTP status when the failure is a remote answer, otherwise null. */
    public Integer status() { return status; }

    /**
     * True when the remote service answered with exactly this status. For translating a remote outcome on purpose:
     * {@code catch (PsoHttpException e) { if (e.isStatus(404)) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "unknown customer"); throw e; }}
     */
    public boolean isStatus(int httpStatus) { return status != null && status == httpStatus; }
}
