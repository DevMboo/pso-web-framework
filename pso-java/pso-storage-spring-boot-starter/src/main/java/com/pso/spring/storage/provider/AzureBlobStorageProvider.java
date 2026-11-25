package com.pso.spring.storage.provider;

import com.azure.core.http.rest.PagedResponse;
import com.azure.core.util.polling.LongRunningOperationStatus;
import com.azure.core.util.polling.SyncPoller;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.models.BlobCopyInfo;
import com.azure.storage.blob.models.BlobErrorCode;
import com.azure.storage.blob.models.BlobHttpHeaders;
import com.azure.storage.blob.models.BlobItem;
import com.azure.storage.blob.models.BlobProperties;
import com.azure.storage.blob.models.BlobRequestConditions;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.models.ListBlobsOptions;
import com.azure.storage.blob.models.UserDelegationKey;
import com.azure.storage.blob.options.BlobParallelUploadOptions;
import com.azure.storage.blob.sas.BlobSasPermission;
import com.azure.storage.blob.sas.BlobServiceSasSignatureValues;
import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageKeys;
import com.pso.spring.storage.StorageProvider;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Azure Blob Storage provider (Azure SDK for Java). Authentication is the application's: the starter builds the client from
 * {@code DefaultAzureCredential} (managed identity, workload identity, developer sign-in) unless a connection string is configured for the
 * Azurite emulator; no account key is ever read from PSO configuration. Blobs are private (no public access level is set), and SAS tokens
 * are issued only for short periods: user delegation SAS with Azure AD credentials, service SAS when the client uses a shared key.
 *
 * <p>Like S3, Blob Storage has no cross-blob transaction: {@code move} is copy then delete. Copy is asynchronous on the service side; this
 * provider waits for it to finish (up to the copy timeout) and treats anything but success as a failure, deleting the partial destination.
 */
public final class AzureBlobStorageProvider implements StorageProvider {

    private final BlobContainerClient container;
    private final BlobServiceClient service;
    private final boolean sharedKey;
    private final String prefix;
    private final Duration copyTimeout;

    /**
     * @param service   used to obtain user delegation keys; may be null when signed URLs are disabled
     * @param sharedKey true when the clients authenticate with an account key (connection string): SAS is then signed with it
     */
    public AzureBlobStorageProvider(BlobContainerClient container, BlobServiceClient service, boolean sharedKey, String prefix, Duration copyTimeout) {
        this.container = container;
        this.service = service;
        this.sharedKey = sharedKey;
        String p = prefix == null ? "" : prefix.replaceAll("^/+|/+$", "");
        this.prefix = p.isEmpty() ? "" : p + "/";
        this.copyTimeout = copyTimeout;
    }

    @Override
    public String name() {
        return "azure";
    }

    private BlobClient blob(String key) {
        return container.getBlobClient(prefix + StorageKeys.requireValid(key));
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
        BlobClient blob = blob(key);
        Path spool = null;
        try {
            InputStream source = content;
            long size = length;
            if (length < 0) { // the Blob API needs the length (or reactive streams): spool, bounded by the caller's limit
                spool = Files.createTempFile("pso-az-", ".part");
                try (var out = Files.newOutputStream(spool)) {
                    content.transferTo(out);
                }
                size = Files.size(spool);
                source = Files.newInputStream(spool);
            }
            BlobParallelUploadOptions opts = new BlobParallelUploadOptions(source, size)
                .setHeaders(new BlobHttpHeaders().setContentType(contentType))
                .setMetadata(ascii(metadata));
            if (!replace) {
                opts.setRequestConditions(new BlobRequestConditions().setIfNoneMatch("*")); // never overwrite
            }
            try (InputStream toClose = source) {
                blob.uploadWithResponse(opts, null, null);
            }
            return new ObjectInfo(key, size, contentType, null, null, Map.of());
        } catch (BlobStorageException e) {
            if (e.getStatusCode() == 409 || e.getStatusCode() == 412 || BlobErrorCode.BLOB_ALREADY_EXISTS.equals(e.getErrorCode())) {
                throw new StorageException.Conflict("an object already exists under this key");
            }
            throw translate(e);
        } catch (RuntimeException | IOException e) {
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
            return blob(key).openInputStream();
        } catch (BlobStorageException e) {
            if (e.getStatusCode() == 404) {
                throw new StorageException.NotFound("no such object");
            }
            throw translate(e);
        }
    }

    @Override
    public Optional<ObjectInfo> stat(String key) {
        try {
            BlobProperties p = blob(key).getProperties();
            return Optional.of(new ObjectInfo(key, p.getBlobSize(), p.getContentType(), p.getETag(), p.getLastModified() == null ? null : p.getLastModified().toInstant(), p.getMetadata()));
        } catch (BlobStorageException e) {
            if (e.getStatusCode() == 404) {
                return Optional.empty();
            }
            throw translate(e);
        }
    }

    @Override
    public void delete(String key) {
        try {
            blob(key).deleteIfExists();
        } catch (BlobStorageException e) {
            throw translate(e);
        }
    }

    @Override
    public void copy(String sourceKey, String destinationKey) {
        BlobClient src = blob(sourceKey);
        BlobClient dst = blob(destinationKey);
        try {
            if (!src.exists()) {
                throw new StorageException.NotFound("no such object");
            }
            if (dst.exists()) {
                throw new StorageException.Conflict("an object already exists under the destination key");
            }
            SyncPoller<BlobCopyInfo, Void> poller = dst.beginCopy(src.getBlobUrl(), Duration.ofSeconds(1));
            var last = poller.waitForCompletion(copyTimeout);
            if (last.getStatus() != LongRunningOperationStatus.SUCCESSFULLY_COMPLETED) {
                dst.deleteIfExists(); // a failed or aborted copy must not leave a partial destination
                throw new StorageException.Unavailable("the blob copy did not complete", null);
            }
        } catch (BlobStorageException | IllegalStateException e) {
            try {
                dst.deleteIfExists();
            } catch (RuntimeException ignored) {
                // the original failure is the one to report
            }
            throw translate(e);
        }
    }

    @Override
    public ObjectPage list(String keyPrefix, String cursor, int limit) {
        try {
            ListBlobsOptions opts = new ListBlobsOptions().setPrefix(prefix + (keyPrefix == null ? "" : keyPrefix)).setMaxResultsPerPage(Math.min(limit, 5000));
            for (PagedResponse<BlobItem> page : container.listBlobs(opts, null).iterableByPage(cursor)) {
                List<ObjectInfo> items = new ArrayList<>();
                for (BlobItem b : page.getValue()) {
                    String name = b.getName().startsWith(prefix) ? b.getName().substring(prefix.length()) : b.getName();
                    long size = b.getProperties() == null || b.getProperties().getContentLength() == null ? 0 : b.getProperties().getContentLength();
                    items.add(new ObjectInfo(name, size, null, null, null, Map.of()));
                }
                return new ObjectPage(items, page.getContinuationToken());
            }
            return new ObjectPage(List.of(), null);
        } catch (BlobStorageException e) {
            throw translate(e);
        }
    }

    @Override
    public Optional<URI> signedUrl(String key, Duration ttl, SignedUrlOptions options) {
        try {
            BlobClient blob = blob(key);
            OffsetDateTime expiry = OffsetDateTime.now().plus(ttl);
            BlobServiceSasSignatureValues values = new BlobServiceSasSignatureValues(expiry, new BlobSasPermission().setReadPermission(true))
                .setContentDisposition("attachment; filename=\"" + options.filename().replaceAll("[^\\x20-\\x7e]|[\"\\\\]", "_") + "\"")
                .setContentType(options.contentType());
            String sas;
            if (sharedKey) {
                sas = blob.generateSas(values);
            } else {
                if (service == null) {
                    return Optional.empty();
                }
                UserDelegationKey delegation = service.getUserDelegationKey(OffsetDateTime.now().minusMinutes(1), expiry);
                sas = blob.generateUserDelegationSas(values, delegation);
            }
            return Optional.of(URI.create(blob.getBlobUrl() + "?" + sas));
        } catch (BlobStorageException e) {
            throw translate(e);
        }
    }

    @Override
    public void healthCheck() {
        try {
            if (!container.exists()) {
                throw new StorageException.Unavailable("the blob container does not exist", null);
            }
        } catch (BlobStorageException e) {
            throw translate(e);
        }
    }

    private static Map<String, String> ascii(Map<String, String> in) {
        return in == null ? Map.of() : in.entrySet().stream().filter(e -> e.getValue() != null && e.getValue().chars().allMatch(c -> c >= 0x20 && c < 0x7f))
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }

    private static StorageException translate(Exception e) {
        return new StorageException.Unavailable("the Azure Blob request failed", e);
    }
}
