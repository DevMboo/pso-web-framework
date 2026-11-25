package com.pso.spring.storage.provider;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageProvider;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import software.amazon.awssdk.awscore.exception.AwsServiceException;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.AbortableInputStream;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CopyObjectRequest;
import software.amazon.awssdk.services.s3.model.CopyObjectResponse;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectResponse;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Response;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectResponse;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.S3Object;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PresignedGetObjectRequest;

/**
 * MOCKED cloud behaviour: the S3 client is a Mockito double backed by an in-memory bucket that mimics S3's observable rules (private objects,
 * 412 on a conditional put, 404 on missing keys, paginated listing). It verifies THIS adapter's request building, key prefixing, error
 * translation and conflict handling. It is not a test against Amazon S3 or an S3-compatible server; no live service was contacted.
 */
class S3StorageProviderTests {

    final Map<String, byte[]> bucket = new TreeMap<>();
    final Map<String, String> types = new TreeMap<>();
    S3Client s3;
    S3Presigner presigner;
    S3StorageProvider provider;

    @BeforeEach
    void setUp() throws IOException {
        s3 = mock(S3Client.class);
        presigner = mock(S3Presigner.class);
        when(s3.putObject(any(PutObjectRequest.class), any(RequestBody.class))).thenAnswer(inv -> {
            PutObjectRequest r = inv.getArgument(0);
            if ("*".equals(r.ifNoneMatch()) && bucket.containsKey(r.key())) {
                throw (S3Exception) S3Exception.builder().statusCode(412).message("PreconditionFailed bucket-secret-name").build();
            }
            RequestBody body = inv.getArgument(1);
            try (InputStream in = body.contentStreamProvider().newStream()) {
                bucket.put(r.key(), in.readAllBytes());
            }
            types.put(r.key(), r.contentType());
            return PutObjectResponse.builder().eTag("\"etag\"").build();
        });
        when(s3.getObject(any(GetObjectRequest.class))).thenAnswer(inv -> {
            GetObjectRequest r = inv.getArgument(0);
            byte[] b = bucket.get(r.key());
            if (b == null) {
                throw NoSuchKeyException.builder().statusCode(404).build();
            }
            return new ResponseInputStream<>(GetObjectResponse.builder().build(), AbortableInputStream.create(new ByteArrayInputStream(b)));
        });
        when(s3.headObject(any(HeadObjectRequest.class))).thenAnswer(inv -> {
            HeadObjectRequest r = inv.getArgument(0);
            byte[] b = bucket.get(r.key());
            if (b == null) {
                throw (S3Exception) S3Exception.builder().statusCode(404).build();
            }
            return HeadObjectResponse.builder().contentLength((long) b.length).contentType(types.get(r.key())).eTag("\"e\"").lastModified(Instant.now()).build();
        });
        when(s3.deleteObject(any(DeleteObjectRequest.class))).thenAnswer(inv -> {
            bucket.remove(((DeleteObjectRequest) inv.getArgument(0)).key());
            return DeleteObjectResponse.builder().build();
        });
        when(s3.copyObject(any(CopyObjectRequest.class))).thenAnswer(inv -> {
            CopyObjectRequest r = inv.getArgument(0);
            bucket.put(r.destinationKey(), bucket.get(r.sourceKey()));
            return CopyObjectResponse.builder().build();
        });
        when(s3.listObjectsV2(any(ListObjectsV2Request.class))).thenAnswer(inv -> {
            ListObjectsV2Request r = inv.getArgument(0);
            var keys = bucket.keySet().stream().filter(k -> k.startsWith(r.prefix())).filter(k -> r.continuationToken() == null || k.compareTo(r.continuationToken()) > 0).toList();
            var page = keys.stream().limit(r.maxKeys()).toList();
            boolean more = keys.size() > page.size();
            return ListObjectsV2Response.builder().contents(page.stream().map(k -> S3Object.builder().key(k).size((long) bucket.get(k).length).build()).toList())
                .isTruncated(more).nextContinuationToken(more ? page.get(page.size() - 1) : null).build();
        });
        provider = new S3StorageProvider(s3, presigner, "private-bucket", "/tenant-a/");
    }

    private static InputStream in(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void putAppliesThePrefixTheContentTypeAndNeverOverwrites() throws IOException {
        provider.put("docs/f_1", in("hello"), 5, "application/pdf", Map.of("k", "v", "bad", "café"));
        assertThat(bucket).containsOnlyKeys("tenant-a/docs/f_1");
        ArgumentCaptor<PutObjectRequest> cap = ArgumentCaptor.forClass(PutObjectRequest.class);
        verify(s3).putObject(cap.capture(), any(RequestBody.class));
        assertThat(cap.getValue().bucket()).isEqualTo("private-bucket");
        assertThat(cap.getValue().contentType()).isEqualTo("application/pdf");
        assertThat(cap.getValue().ifNoneMatch()).isEqualTo("*");
        assertThat(cap.getValue().acl()).as("objects are private: no ACL is ever set").isNull();
        assertThat(cap.getValue().metadata()).containsEntry("k", "v").doesNotContainKey("bad");
        assertThatThrownBy(() -> provider.put("docs/f_1", in("again"), 5, "text/plain", Map.of())).isInstanceOf(StorageException.Conflict.class);
        assertThat(new String(bucket.get("tenant-a/docs/f_1"))).isEqualTo("hello");
    }

    @Test
    void unknownLengthIsSpooledBecauseS3NeedsTheLength() throws IOException {
        StorageProvider.ObjectInfo info = provider.put("docs/f_2", in("0123456789"), -1, "text/plain", Map.of());
        assertThat(info.size()).isEqualTo(10);
        assertThat(new String(bucket.get("tenant-a/docs/f_2"))).isEqualTo("0123456789");
    }

    @Test
    void replaceOverwritesWithoutAConditionalPut() throws IOException {
        provider.put("_pso/files/f_x.json", in("v1"), 2, "application/json", Map.of());
        provider.replace("_pso/files/f_x.json", in("v2"), 2, "application/json", Map.of());
        assertThat(new String(bucket.get("tenant-a/_pso/files/f_x.json"))).isEqualTo("v2");
    }

    @Test
    void getStatDeleteAndNotFound() throws IOException {
        provider.put("a/b", in("x"), 1, "text/plain", Map.of());
        try (InputStream s = provider.get("a/b")) {
            assertThat(new String(s.readAllBytes())).isEqualTo("x");
        }
        assertThat(provider.stat("a/b")).get().satisfies(i -> {
            assertThat(i.key()).isEqualTo("a/b");
            assertThat(i.size()).isEqualTo(1);
        });
        assertThat(provider.exists("a/missing")).isFalse();
        assertThatThrownBy(() -> provider.get("a/missing")).isInstanceOf(StorageException.NotFound.class);
        provider.delete("a/b");
        provider.delete("a/b");
        assertThat(bucket).isEmpty();
    }

    @Test
    void copyAndMoveAreCopyThenDeleteAndNeverOverwrite() {
        provider.put("a/one", in("1"), 1, "text/plain", Map.of());
        provider.put("a/two", in("2"), 1, "text/plain", Map.of());
        provider.copy("a/one", "b/copy");
        assertThat(bucket).containsKeys("tenant-a/a/one", "tenant-a/b/copy");
        assertThatThrownBy(() -> provider.copy("a/one", "a/two")).isInstanceOf(StorageException.Conflict.class);
        assertThatThrownBy(() -> provider.copy("a/ghost", "a/new")).isInstanceOf(StorageException.NotFound.class);
        provider.move("a/one", "c/moved");
        assertThat(bucket).containsKey("tenant-a/c/moved").doesNotContainKey("tenant-a/a/one");
        assertThat(provider.atomicMove()).isFalse();
    }

    @Test
    void listsWithTheContinuationTokenAndStripsThePrefix() {
        for (int i = 0; i < 5; i++) {
            provider.put("l/k" + i, in("v"), 1, "text/plain", Map.of());
        }
        StorageProvider.ObjectPage p1 = provider.list("l/", null, 2);
        assertThat(p1.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("l/k0", "l/k1");
        StorageProvider.ObjectPage p2 = provider.list("l/", p1.nextCursor(), 2);
        assertThat(p2.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("l/k2", "l/k3");
        StorageProvider.ObjectPage p3 = provider.list("l/", p2.nextCursor(), 2);
        assertThat(p3.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("l/k4");
        assertThat(p3.nextCursor()).isNull();
    }

    @Test
    void signedUrlIsShortLivedAndForcesAttachment() throws Exception {
        PresignedGetObjectRequest presigned = mock(PresignedGetObjectRequest.class);
        when(presigned.url()).thenReturn(new URL("https://private-bucket.s3.amazonaws.com/tenant-a/a/b?X-Amz-Expires=60&X-Amz-Signature=sig"));
        when(presigner.presignGetObject(any(GetObjectPresignRequest.class))).thenReturn(presigned);
        var url = provider.signedUrl("a/b", Duration.ofSeconds(60), new StorageProvider.SignedUrlOptions("Relát\"rio.pdf", "application/pdf"));
        assertThat(url).isPresent();
        ArgumentCaptor<GetObjectPresignRequest> cap = ArgumentCaptor.forClass(GetObjectPresignRequest.class);
        verify(presigner).presignGetObject(cap.capture());
        assertThat(cap.getValue().signatureDuration()).isEqualTo(Duration.ofSeconds(60));
        assertThat(cap.getValue().getObjectRequest().responseContentDisposition()).startsWith("attachment;").doesNotContain("\"Relá").doesNotContain("á");
        assertThat(new S3StorageProvider(s3, null, "b", "").signedUrl("a/b", Duration.ofSeconds(1), new StorageProvider.SignedUrlOptions("a", "text/plain"))).as("no presigner, no URL").isEmpty();
    }

    @Test
    void providerFailuresBecomeUnavailableWithoutLeakingDetail() {
        when(s3.listObjectsV2(any(ListObjectsV2Request.class))).thenThrow(AwsServiceException.builder().message("AccessDenied: arn:aws:iam::123456789012:user/x on bucket private-bucket").statusCode(403).build());
        assertThatThrownBy(() -> provider.list("", null, 10)).isInstanceOf(StorageException.Unavailable.class).hasMessageNotContaining("123456789012").hasMessageNotContaining("private-bucket");
        when(s3.headBucket(any(HeadBucketRequest.class))).thenThrow(SdkClientException.create("Unable to load credentials"));
        assertThatThrownBy(provider::healthCheck).isInstanceOf(StorageException.Unavailable.class).hasMessageNotContaining("credentials");
    }

    @Test
    void aSizeLimitRaisedWhileTheSdkReadsTheStreamSurfacesAsTooLarge() {
        when(s3.putObject(any(PutObjectRequest.class), any(RequestBody.class))).thenThrow(SdkClientException.create("Unable to execute HTTP request", new StorageException.TooLarge(5)));
        assertThatThrownBy(() -> provider.put("a/big", in("0123456789"), 10, "text/plain", Map.of())).isInstanceOf(StorageException.TooLarge.class);
    }

    @Test
    void keysAreValidatedBeforeAnySdkCall() {
        assertThatThrownBy(() -> provider.get("../escape")).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> provider.put("/abs", in("x"), 1, null, Map.of())).isInstanceOf(StorageException.Invalid.class);
        org.mockito.Mockito.verifyNoInteractions(s3);
    }
}
