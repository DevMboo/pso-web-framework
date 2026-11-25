package com.pso.spring.storage.provider;

import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageKeys;
import com.pso.spring.storage.StorageProvider;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CopyObjectRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Response;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;

/**
 * Amazon S3 provider (AWS SDK for Java v2). Credentials come from the SDK's default provider chain (environment, profile, web identity,
 * container or instance role): none is ever read from PSO configuration. Objects are private: no ACL is set and signed URLs are the only
 * way to hand access to a client directly.
 *
 * <p>S3 has no cross-object transactions: {@code move} is copy then delete, so a failure between the two leaves both objects (never none).
 * {@code copy} uses the server-side CopyObject call, which S3 limits to 5 GB per object.
 * Without a known content length the stream is spooled to a temporary file first (S3 needs the length up front), bounded by the caller's limit.
 */
public final class S3StorageProvider implements StorageProvider {

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String bucket;
    private final String prefix;

    /** @param presigner may be null when signed URLs are disabled */
    public S3StorageProvider(S3Client s3, S3Presigner presigner, String bucket, String prefix) {
        this.s3 = s3;
        this.presigner = presigner;
        this.bucket = bucket;
        String p = prefix == null ? "" : prefix.replaceAll("^/+|/+$", "");
        this.prefix = p.isEmpty() ? "" : p + "/";
    }

    @Override
    public String name() {
        return "s3";
    }

    private String full(String key) {
        return prefix + StorageKeys.requireValid(key);
    }

    private String relative(String objectKey) {
        return objectKey.startsWith(prefix) ? objectKey.substring(prefix.length()) : objectKey;
    }

    @Override
    public ObjectInfo put(String key, InputStream content, long contentLength, String contentType, Map<String, String> metadata) {
        return write(key, content, contentLength, contentType, metadata, false);
    }

    @Override
    public ObjectInfo replace(String key, InputStream content, long contentLength, String contentType, Map<String, String> metadata) {
        return write(key, content, contentLength, contentType, metadata, true);
    }

    private ObjectInfo write(String key, InputStream content, long length, String contentType, Map<String, String> metadata, boolean replace) {
        String objectKey = full(key);
        Path spool = null;
        try {
            PutObjectRequest.Builder req = PutObjectRequest.builder().bucket(bucket).key(objectKey).contentType(contentType).metadata(ascii(metadata));
            if (!replace) {
                req.ifNoneMatch("*"); // never overwrite: S3 answers 412 when the key exists
            }
            RequestBody body;
            if (length >= 0) {
                body = RequestBody.fromInputStream(content, length);
            } else {
                spool = Files.createTempFile("pso-s3-", ".part");
                try (var out = Files.newOutputStream(spool)) {
                    content.transferTo(out);
                }
                body = RequestBody.fromFile(spool);
            }
            var res = s3.putObject(req.build(), body);
            long size = length >= 0 ? length : Files.size(spool);
            return new ObjectInfo(key, size, contentType, res.eTag(), null, Map.of());
        } catch (S3Exception e) {
            if (e.statusCode() == 412 || e.statusCode() == 409) {
                throw new StorageException.Conflict("an object already exists under this key");
            }
            throw translate(e);
        } catch (SdkException | IOException e) {
            StorageException.TooLarge big = StorageException.find(e, StorageException.TooLarge.class);
            if (big != null) {
                throw big;
            }
            throw translate(e);
        } finally {
            if (spool != null) {
                try {
                    Files.deleteIfExists(spool);
                } catch (IOException ignored) {
                    // temp directory cleanup is the OS's job
                }
            }
        }
    }

    @Override
    public InputStream get(String key) {
        try {
            ResponseInputStream<GetObjectResponse> in = s3.getObject(GetObjectRequest.builder().bucket(bucket).key(full(key)).build());
            return in;
        } catch (NoSuchKeyException e) {
            throw new StorageException.NotFound("no such object");
        } catch (S3Exception e) {
            if (e.statusCode() == 404) {
                throw new StorageException.NotFound("no such object");
            }
            throw translate(e);
        } catch (SdkException e) {
            throw translate(e);
        }
    }

    @Override
    public Optional<ObjectInfo> stat(String key) {
        try {
            HeadObjectResponse h = s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(full(key)).build());
            return Optional.of(new ObjectInfo(key, h.contentLength() == null ? 0 : h.contentLength(), h.contentType(), h.eTag(), h.lastModified(), h.metadata()));
        } catch (NoSuchKeyException e) {
            return Optional.empty();
        } catch (S3Exception e) {
            if (e.statusCode() == 404) {
                return Optional.empty();
            }
            throw translate(e);
        } catch (SdkException e) {
            throw translate(e);
        }
    }

    @Override
    public void delete(String key) {
        try {
            s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(full(key)).build()); // S3 answers 204 for a missing key: idempotent
        } catch (SdkException e) {
            throw translate(e);
        }
    }

    @Override
    public void copy(String sourceKey, String destinationKey) {
        if (stat(sourceKey).isEmpty()) {
            throw new StorageException.NotFound("no such object");
        }
        if (stat(destinationKey).isPresent()) {
            throw new StorageException.Conflict("an object already exists under the destination key");
        }
        try {
            s3.copyObject(CopyObjectRequest.builder().sourceBucket(bucket).sourceKey(full(sourceKey)).destinationBucket(bucket).destinationKey(full(destinationKey)).build());
        } catch (SdkException e) {
            throw translate(e);
        }
    }

    @Override
    public ObjectPage list(String keyPrefix, String cursor, int limit) {
        try {
            ListObjectsV2Request.Builder req = ListObjectsV2Request.builder().bucket(bucket).prefix(prefix + (keyPrefix == null ? "" : keyPrefix)).maxKeys(Math.min(limit, 1000));
            if (cursor != null) {
                req.continuationToken(cursor);
            }
            ListObjectsV2Response res = s3.listObjectsV2(req.build());
            List<ObjectInfo> items = new ArrayList<>();
            res.contents().forEach(o -> items.add(new ObjectInfo(relative(o.key()), o.size() == null ? 0 : o.size(), null, o.eTag(), o.lastModified(), Map.of())));
            return new ObjectPage(items, Boolean.TRUE.equals(res.isTruncated()) ? res.nextContinuationToken() : null);
        } catch (SdkException e) {
            throw translate(e);
        }
    }

    @Override
    public Optional<URI> signedUrl(String key, Duration ttl, SignedUrlOptions options) {
        if (presigner == null) {
            return Optional.empty();
        }
        try {
            GetObjectRequest.Builder get = GetObjectRequest.builder().bucket(bucket).key(full(key))
                .responseContentDisposition("attachment; filename=\"" + options.filename().replaceAll("[^\\x20-\\x7e]|[\"\\\\]", "_") + "\"")
                .responseContentType(options.contentType());
            return Optional.of(presigner.presignGetObject(GetObjectPresignRequest.builder().signatureDuration(ttl).getObjectRequest(get.build()).build()).url().toURI());
        } catch (SdkException | java.net.URISyntaxException e) {
            throw translate(e);
        }
    }

    @Override
    public void healthCheck() {
        try {
            s3.headBucket(HeadBucketRequest.builder().bucket(bucket).build());
        } catch (SdkException e) {
            throw translate(e);
        }
    }

    private static Map<String, String> ascii(Map<String, String> in) {
        return in == null ? Map.of() : in.entrySet().stream().filter(e -> e.getValue() != null && e.getValue().chars().allMatch(c -> c >= 0x20 && c < 0x7f))
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }

    /** Provider detail (bucket, account, request ids) stays in the cause: it is never shown to a client. */
    private static StorageException translate(Exception e) {
        return new StorageException.Unavailable("the S3 request failed", e);
    }
}
