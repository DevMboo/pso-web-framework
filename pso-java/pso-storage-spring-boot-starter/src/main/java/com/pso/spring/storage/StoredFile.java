package com.pso.spring.storage;

import java.time.Instant;
import java.util.Map;

/**
 * The metadata of a stored file. {@code id} is the opaque, stable, application-facing identifier; {@code key} is the internal storage key
 * (never put it, a bucket name or a filesystem path in a response: use {@link #view()}). Possessing an id grants nothing: every operation
 * goes through the {@link StorageAccessPolicy}.
 *
 * @param uploadedBy  subject of the caller that stored the file (set by the framework, never by the client)
 * @param ownerRef    business owner chosen by the application (e.g. {@code employee:42}); separate from storage identity
 * @param context     optional business context (small string map)
 */
public record StoredFile(String id, String filename, String key, String contentType, long size, String provider, Instant createdAt,
                         String uploadedBy, String ownerRef, String checksumSha256, Map<String, String> context) {

    public StoredFile {
        context = context == null ? Map.of() : Map.copyOf(context);
    }

    public StoredFile withKey(String newKey) {
        return new StoredFile(id, filename, newKey, contentType, size, provider, createdAt, uploadedBy, ownerRef, checksumSha256, context);
    }

    /** What an API may return to a client: no key, no provider, no uploader. */
    public FileView view() {
        return new FileView(id, filename, contentType, size, createdAt, ownerRef, checksumSha256, context);
    }

    public record FileView(String id, String filename, String contentType, long size, Instant createdAt, String ownerRef, String checksumSha256,
                           Map<String, String> context) {
    }
}
