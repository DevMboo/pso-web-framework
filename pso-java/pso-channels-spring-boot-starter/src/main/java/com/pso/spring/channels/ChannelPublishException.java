package com.pso.spring.channels;

/** A channel event could not be published. The message states the cause and the fix; it never contains payload content. */
public class ChannelPublishException extends RuntimeException {

    private final String code;

    public ChannelPublishException(String code, String message) {
        super(message);
        this.code = code;
    }

    public ChannelPublishException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    /** Stable code: PSO_CHANNEL_INVALID_CHANNEL, _INVALID_EVENT, _INVALID_PAYLOAD, _PAYLOAD_TOO_LARGE, _DURABLE_UNAVAILABLE, _TRANSPORT. */
    public String code() {
        return code;
    }
}
