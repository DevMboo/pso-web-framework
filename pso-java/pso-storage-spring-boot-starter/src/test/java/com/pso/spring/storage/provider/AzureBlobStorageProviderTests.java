package com.pso.spring.storage.provider;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.azure.core.http.rest.PagedResponse;
import com.azure.core.util.polling.LongRunningOperationStatus;
import com.azure.core.util.polling.PollResponse;
import com.azure.core.util.polling.SyncPoller;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.models.BlobCopyInfo;
import com.azure.storage.blob.models.BlobErrorCode;
import com.azure.storage.blob.models.BlobItem;
import com.azure.storage.blob.models.BlobItemProperties;
import com.azure.storage.blob.models.BlobProperties;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.models.ListBlobsOptions;
import com.azure.storage.blob.models.UserDelegationKey;
import com.azure.storage.blob.options.BlobParallelUploadOptions;
import com.azure.storage.blob.sas.BlobServiceSasSignatureValues;
import com.azure.core.http.rest.Response;
import com.azure.core.http.rest.PagedIterable;
import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageProvider;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * MOCKED cloud behaviour: the Azure SDK clients are Mockito doubles. They verify THIS adapter's request building (conditional upload, key
 * prefixing, copy polling and cleanup, SAS choice and expiry, error translation). They are not tests against Azure Blob Storage or Azurite;
 * no live service was contacted.
 */
class AzureBlobStorageProviderTests {

    BlobContainerClient container;
    BlobServiceClient service;
    BlobClient blob;
    BlobClient other;
    AzureBlobStorageProvider provider;

    @BeforeEach
    void setUp() {
        container = mock(BlobContainerClient.class);
        service = mock(BlobServiceClient.class);
        blob = mock(BlobClient.class);
        other = mock(BlobClient.class);
        when(container.getBlobClient("tenant-a/a/one")).thenReturn(blob);
        when(container.getBlobClient("tenant-a/b/two")).thenReturn(other);
        when(blob.getBlobUrl()).thenReturn("https://acct.blob.core.windows.net/docs/tenant-a/a/one");
        provider = new AzureBlobStorageProvider(container, service, false, "tenant-a", Duration.ofSeconds(5));
    }

    private static InputStream in(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }

    /** A real BlobStorageException built over a stubbed HTTP response (a mocked Throwable has no stack trace and breaks test reporting). */
    private static BlobStorageException storageError(int status, BlobErrorCode code) {
        com.azure.core.http.HttpResponse response = mock(com.azure.core.http.HttpResponse.class);
        com.azure.core.http.HttpHeaders headers = new com.azure.core.http.HttpHeaders();
        if (code != null) {
            headers.set("x-ms-error-code", code.toString());
        }
        when(response.getStatusCode()).thenReturn(status);
        when(response.getHeaders()).thenReturn(headers);
        when(response.getRequest()).thenReturn(new com.azure.core.http.HttpRequest(com.azure.core.http.HttpMethod.GET, "https://acct.blob.core.windows.net/docs/x"));
        return new BlobStorageException("Status code " + status + ", account acct container docs secret-detail", response, null);
    }

    @Test
    @SuppressWarnings("unchecked")
    void uploadIsConditionalSoItNeverOverwritesAndKeepsTheContentType() {
        when(blob.uploadWithResponse(any(BlobParallelUploadOptions.class), any(), any())).thenReturn(mock(Response.class));
        provider.put("a/one", in("hello"), 5, "application/pdf", Map.of("k", "v", "bad", "café"));
        ArgumentCaptor<BlobParallelUploadOptions> cap = ArgumentCaptor.forClass(BlobParallelUploadOptions.class);
        verify(blob).uploadWithResponse(cap.capture(), any(), any());
        assertThat(cap.getValue().getRequestConditions().getIfNoneMatch()).isEqualTo("*");
        assertThat(cap.getValue().getHeaders().getContentType()).isEqualTo("application/pdf");
        assertThat(cap.getValue().getMetadata()).containsEntry("k", "v").doesNotContainKey("bad");
    }

    @Test
    @SuppressWarnings("unchecked")
    void aBlobThatAlreadyExistsIsAConflict() {
        { BlobStorageException ex = storageError(409, BlobErrorCode.BLOB_ALREADY_EXISTS); org.mockito.Mockito.doThrow(ex).when(blob).uploadWithResponse(any(BlobParallelUploadOptions.class), any(), any()); }
        assertThatThrownBy(() -> provider.put("a/one", in("x"), 1, "text/plain", Map.of())).isInstanceOf(StorageException.Conflict.class);
        { BlobStorageException ex = storageError(412, BlobErrorCode.CONDITION_NOT_MET); org.mockito.Mockito.doThrow(ex).when(blob).uploadWithResponse(any(BlobParallelUploadOptions.class), any(), any()); }
        assertThatThrownBy(() -> provider.put("a/one", in("x"), 1, "text/plain", Map.of())).isInstanceOf(StorageException.Conflict.class);
    }

    @Test
    @SuppressWarnings("unchecked")
    void replaceHasNoCondition() {
        when(blob.uploadWithResponse(any(BlobParallelUploadOptions.class), any(), any())).thenReturn(mock(Response.class));
        provider.replace("a/one", in("v2"), 2, "application/json", Map.of());
        ArgumentCaptor<BlobParallelUploadOptions> cap = ArgumentCaptor.forClass(BlobParallelUploadOptions.class);
        verify(blob).uploadWithResponse(cap.capture(), any(), any());
        assertThat(cap.getValue().getRequestConditions()).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void unknownLengthIsSpooledAndAStreamLimitSurfacesAsTooLarge() {
        when(blob.uploadWithResponse(any(BlobParallelUploadOptions.class), any(), any())).thenReturn(mock(Response.class));
        assertThat(provider.put("a/one", in("0123456789"), -1, "text/plain", Map.of()).size()).isEqualTo(10);
        InputStream failing = new InputStream() {
            @Override
            public int read() {
                throw new StorageException.TooLarge(3);
            }
        };
        assertThatThrownBy(() -> provider.put("a/one", failing, -1, "text/plain", Map.of())).isInstanceOf(StorageException.TooLarge.class);
    }

    @Test
    void statMapsAMissingBlobToEmpty_andOtherErrorsToUnavailableWithoutDetail() {
        BlobProperties props = mock(BlobProperties.class);
        when(props.getBlobSize()).thenReturn(42L);
        when(props.getContentType()).thenReturn("text/plain");
        when(props.getLastModified()).thenReturn(OffsetDateTime.now());
        when(blob.getProperties()).thenReturn(props);
        assertThat(provider.stat("a/one")).get().satisfies(i -> assertThat(i.size()).isEqualTo(42));
        { BlobStorageException ex = storageError(404, BlobErrorCode.BLOB_NOT_FOUND); org.mockito.Mockito.doThrow(ex).when(blob).getProperties(); }
        assertThat(provider.stat("a/one")).isEmpty();
        { BlobStorageException ex = storageError(403, BlobErrorCode.AUTHORIZATION_FAILURE); org.mockito.Mockito.doThrow(ex).when(blob).getProperties(); }
        assertThatThrownBy(() -> provider.stat("a/one")).isInstanceOf(StorageException.Unavailable.class).hasMessageNotContaining("acct").hasMessageNotContaining("secret-detail");
        { BlobStorageException ex = storageError(404, BlobErrorCode.BLOB_NOT_FOUND); org.mockito.Mockito.doThrow(ex).when(blob).openInputStream(); }
        assertThatThrownBy(() -> provider.get("a/one")).isInstanceOf(StorageException.NotFound.class);
    }

    @Test
    void deleteIsIdempotent() {
        provider.delete("a/one");
        verify(blob).deleteIfExists();
    }

    @Test
    @SuppressWarnings("unchecked")
    void copyWaitsForTheAsynchronousCopyAndRemovesAFailedDestination() {
        when(blob.exists()).thenReturn(true);
        when(other.exists()).thenReturn(false);
        SyncPoller<BlobCopyInfo, Void> poller = mock(SyncPoller.class);
        PollResponse<BlobCopyInfo> done = mock(PollResponse.class);
        when(done.getStatus()).thenReturn(LongRunningOperationStatus.SUCCESSFULLY_COMPLETED);
        when(poller.waitForCompletion(any(Duration.class))).thenReturn(done);
        when(other.beginCopy(eq("https://acct.blob.core.windows.net/docs/tenant-a/a/one"), any(Duration.class))).thenReturn(poller);
        provider.copy("a/one", "b/two");
        verify(poller).waitForCompletion(Duration.ofSeconds(5));
        verify(other, never()).deleteIfExists();

        PollResponse<BlobCopyInfo> failed = mock(PollResponse.class);
        when(failed.getStatus()).thenReturn(LongRunningOperationStatus.FAILED);
        when(poller.waitForCompletion(any(Duration.class))).thenReturn(failed);
        assertThatThrownBy(() -> provider.copy("a/one", "b/two")).isInstanceOf(StorageException.Unavailable.class);
        verify(other).deleteIfExists();
    }

    @Test
    void copyNeverOverwritesAndNeedsASource() {
        when(blob.exists()).thenReturn(true);
        when(other.exists()).thenReturn(true);
        assertThatThrownBy(() -> provider.copy("a/one", "b/two")).isInstanceOf(StorageException.Conflict.class);
        when(blob.exists()).thenReturn(false);
        assertThatThrownBy(() -> provider.copy("a/one", "b/two")).isInstanceOf(StorageException.NotFound.class);
        assertThat(provider.atomicMove()).isFalse();
    }

    @Test
    @SuppressWarnings("unchecked")
    void listsOnePagePerCallWithTheContinuationToken() {
        BlobItem item = new BlobItem().setName("tenant-a/l/k0").setProperties(new BlobItemProperties().setContentLength(7L));
        PagedResponse<BlobItem> page = mock(PagedResponse.class);
        when(page.getValue()).thenReturn(List.of(item));
        when(page.getContinuationToken()).thenReturn("next-token");
        PagedIterable<BlobItem> iterable = mock(PagedIterable.class);
        when(iterable.iterableByPage("tok")).thenReturn(List.of(page));
        when(container.listBlobs(any(ListBlobsOptions.class), any())).thenReturn(iterable);
        StorageProvider.ObjectPage p = provider.list("l/", "tok", 10);
        assertThat(p.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("l/k0");
        assertThat(p.items().get(0).size()).isEqualTo(7);
        assertThat(p.nextCursor()).isEqualTo("next-token");
        ArgumentCaptor<ListBlobsOptions> cap = ArgumentCaptor.forClass(ListBlobsOptions.class);
        verify(container).listBlobs(cap.capture(), any());
        assertThat(cap.getValue().getPrefix()).isEqualTo("tenant-a/l/");
    }

    @Test
    void signedUrlUsesAUserDelegationKeyWithAnAadClient_andAnExpiry() {
        UserDelegationKey key = mock(UserDelegationKey.class);
        when(service.getUserDelegationKey(any(OffsetDateTime.class), any(OffsetDateTime.class))).thenReturn(key);
        when(blob.generateUserDelegationSas(any(BlobServiceSasSignatureValues.class), eq(key))).thenReturn("sv=2024&sig=abc&se=soon");
        var url = provider.signedUrl("a/one", Duration.ofMinutes(2), new StorageProvider.SignedUrlOptions("résumé.pdf", "application/pdf"));
        assertThat(url).get().isEqualTo(URI.create("https://acct.blob.core.windows.net/docs/tenant-a/a/one?sv=2024&sig=abc&se=soon"));
        ArgumentCaptor<BlobServiceSasSignatureValues> cap = ArgumentCaptor.forClass(BlobServiceSasSignatureValues.class);
        verify(blob).generateUserDelegationSas(cap.capture(), eq(key));
        assertThat(cap.getValue().getExpiryTime()).isBefore(OffsetDateTime.now().plusMinutes(3)).isAfter(OffsetDateTime.now().plusMinutes(1));
        assertThat(cap.getValue().getPermissions()).isEqualTo("r");
        assertThat(cap.getValue().getContentDisposition()).startsWith("attachment;").doesNotContain("é");
        assertThat(cap.getValue().getContentType()).isEqualTo("application/pdf");
    }

    @Test
    void signedUrlUsesTheAccountKeyOnlyWhenTheClientAuthenticatesWithOne() {
        AzureBlobStorageProvider shared = new AzureBlobStorageProvider(container, null, true, "tenant-a", Duration.ofSeconds(5));
        when(blob.generateSas(any(BlobServiceSasSignatureValues.class))).thenReturn("sig=shared");
        assertThat(shared.signedUrl("a/one", Duration.ofMinutes(1), new StorageProvider.SignedUrlOptions("a.pdf", "application/pdf"))).get().asString().endsWith("?sig=shared");
        AzureBlobStorageProvider noService = new AzureBlobStorageProvider(container, null, false, "tenant-a", Duration.ofSeconds(5));
        assertThat(noService.signedUrl("a/one", Duration.ofMinutes(1), new StorageProvider.SignedUrlOptions("a.pdf", "application/pdf"))).isEmpty();
    }

    @Test
    void healthCheckReportsAMissingContainerWithoutDetail() {
        when(container.exists()).thenReturn(true);
        provider.healthCheck();
        when(container.exists()).thenReturn(false);
        assertThatThrownBy(provider::healthCheck).isInstanceOf(StorageException.Unavailable.class);
    }

    @Test
    void keysAreValidatedBeforeAnySdkCall() {
        assertThatThrownBy(() -> provider.get("../x")).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> provider.delete("/abs")).isInstanceOf(StorageException.Invalid.class);
        org.mockito.Mockito.verify(container, never()).getBlobClient(anyString());
    }
}
