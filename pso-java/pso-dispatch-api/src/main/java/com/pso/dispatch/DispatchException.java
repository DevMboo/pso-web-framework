package com.pso.dispatch;

/** A dispatch failure with a stable code. Messages never contain payloads, credentials or broker URLs. */
public class DispatchException extends RuntimeException {

    private final String code;

    public DispatchException(String code, String message) {
        super(message);
        this.code = code;
    }

    public DispatchException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
