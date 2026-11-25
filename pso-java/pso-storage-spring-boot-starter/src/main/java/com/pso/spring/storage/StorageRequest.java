package com.pso.spring.storage;

import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** What to store. Build with {@link #builder(InputStream)}. The stream is read once, to its end, and closed by the service. */
public final class StorageRequest {

    private final InputStream content;
    private final String filename;
    private final String contentType;
    private final long contentLength;
    private final String ownerRef;
    private final String namespace;
    private final Map<String, String> context;
    private final UploadPolicy policy;

    private StorageRequest(Builder b) {
        this.content = Objects.requireNonNull(b.content, "content");
        this.filename = b.filename;
        this.contentType = b.contentType;
        this.contentLength = b.contentLength;
        this.ownerRef = b.ownerRef;
        this.namespace = b.namespace == null ? "" : b.namespace;
        this.context = Map.copyOf(b.context);
        this.policy = b.policy;
    }

    public InputStream content() { return content; }
    /** Client-supplied name: sanitized before it is stored; never used as a storage key. */
    public String filename() { return filename; }
    public String contentType() { return contentType; }
    /** Exact size when known, else -1. */
    public long contentLength() { return contentLength; }
    public String ownerRef() { return ownerRef; }
    public String namespace() { return namespace; }
    public Map<String, String> context() { return context; }
    /** A policy for this call only (e.g. smaller size, PDF only); null means the configured default. It can never be looser than the hard limits. */
    public UploadPolicy policy() { return policy; }

    public static Builder builder(InputStream content) {
        return new Builder(content);
    }

    public static final class Builder {
        private final InputStream content;
        private String filename;
        private String contentType;
        private long contentLength = -1;
        private String ownerRef;
        private String namespace;
        private final Map<String, String> context = new LinkedHashMap<>();
        private UploadPolicy policy;

        private Builder(InputStream content) { this.content = content; }

        public Builder filename(String v) { this.filename = v; return this; }
        public Builder contentType(String v) { this.contentType = v; return this; }
        public Builder contentLength(long v) { this.contentLength = v; return this; }
        public Builder ownerRef(String v) { this.ownerRef = v; return this; }
        public Builder namespace(String v) { this.namespace = v; return this; }
        public Builder context(String key, String value) { this.context.put(key, value); return this; }
        public Builder policy(UploadPolicy v) { this.policy = v; return this; }
        public StorageRequest build() { return new StorageRequest(this); }
    }
}
