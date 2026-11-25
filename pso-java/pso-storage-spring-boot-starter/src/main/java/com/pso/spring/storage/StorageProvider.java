package com.pso.spring.storage;

import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Provider SPI: a flat key to bytes store. It knows nothing about owners, permissions or file identifiers (that is
 * {@link PsoStorageService}); it only stores, reads, copies, moves, deletes and lists objects by validated key. Implement it (and register
 * a bean) to add a backend; the framework abstractions never mention a particular vendor.
 *
 * <p>Contract: keys are validated with {@link StorageKeys#requireValid(String)}; {@code put}, {@code copy} and {@code move} never overwrite
 * (they throw {@link StorageException.Conflict}); a failed {@code put} leaves no visible object; {@code delete} of a missing key is a no-op;
 * provider specific exceptions are translated to {@link StorageException} (the original stays as the cause).
 * Cross-object operations ({@code copy}, {@code move}) are NOT transactional on object stores.
 */
public interface StorageProvider {

    /** Name used in metadata and logs: {@code local}, {@code s3}, {@code azure}. */
    String name();

    /**
     * Stores the content. {@code contentLength} is the exact size when known, or -1. {@code metadata} is ASCII-safe provider metadata (may be ignored).
     * The stream is read to its end and not closed by the provider.
     */
    ObjectInfo put(String key, InputStream content, long contentLength, String contentType, Map<String, String> metadata);

    /**
     * Stores the content, atomically replacing an existing object. Used only for the framework's own small metadata records; file content
     * is always written with {@link #put}, which refuses to overwrite.
     */
    ObjectInfo replace(String key, InputStream content, long contentLength, String contentType, Map<String, String> metadata);

    /** Opens the content; the caller closes it. */
    InputStream get(String key);

    Optional<ObjectInfo> stat(String key);

    default boolean exists(String key) {
        return stat(key).isPresent();
    }

    void delete(String key);

    /** Copies without overwriting. */
    void copy(String sourceKey, String destinationKey);

    /** True when {@link #move} is a single atomic rename (local filesystem); object stores copy then delete. */
    default boolean atomicMove() {
        return false;
    }

    /** Moves without overwriting. Default: copy then delete (object stores); the local provider renames atomically. */
    default void move(String sourceKey, String destinationKey) {
        copy(sourceKey, destinationKey);
        delete(sourceKey);
    }

    /** Lists keys under {@code prefix} in key order, at most {@code limit} per page; {@code cursor} is opaque and comes from the previous page. */
    ObjectPage list(String prefix, String cursor, int limit);

    /** A short-lived URL the client can use directly, when the backend supports it. Empty when it does not (local storage). */
    default Optional<URI> signedUrl(String key, Duration ttl, SignedUrlOptions options) {
        return Optional.empty();
    }

    /** Throws when the backend is not reachable or not usable (credentials, bucket, directory). */
    default void healthCheck() {
    }

    record SignedUrlOptions(String filename, String contentType) {
    }

    record ObjectInfo(String key, long size, String contentType, String etag, Instant lastModified, Map<String, String> metadata) {
    }

    record ObjectPage(List<ObjectInfo> items, String nextCursor) {
    }
}
