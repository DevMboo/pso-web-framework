package com.pso.spring.storage;

import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.storage.provider.AzureBlobStorageProvider;
import com.pso.spring.storage.provider.LocalFileSystemProvider;
import com.pso.spring.storage.provider.S3StorageProvider;
import com.pso.spring.storage.web.StorageProblemAdvice;
import java.net.URI;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * PSO Storage auto-configuration. It does nothing unless {@code pso.storage.provider} is set: a service that does not use files is never
 * asked for a bucket, an account or a root directory, and no provider SDK is loaded. With a provider selected, every bean backs off when the
 * application defines its own (a {@link StorageProvider}, {@link FileMetadataStore}, {@link StorageAccess.Policy}, ...).
 */
@AutoConfiguration(after = PsoAutoConfiguration.class)
@ConditionalOnProperty(prefix = "pso.storage", name = "provider")
public class PsoStorageAutoConfiguration {

    private static final Logger LOG = LoggerFactory.getLogger(PsoStorageAutoConfiguration.class);

    // ------------------------------------------------------------------ providers
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.storage", name = "provider", havingValue = "local")
    static class LocalProviderConfiguration {
        @Bean
        @ConditionalOnMissingBean(StorageProvider.class)
        StorageProvider psoLocalStorageProvider(PsoProperties props) {
            String root = props.getStorage().getLocal().getRoot();
            if (root == null || root.isBlank()) {
                throw new IllegalStateException("pso.storage.local.root is required when pso.storage.provider=local (example: ./storage)");
            }
            if (props.getStorage().getSignedUrl().isEnabled()) {
                LOG.warn("pso.storage.signed-url.enabled has no effect with the local provider: it cannot sign URLs; use the authenticated download route");
            }
            return new LocalFileSystemProvider(Path.of(root));
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.storage", name = "provider", havingValue = "s3")
    @ConditionalOnClass(name = "software.amazon.awssdk.services.s3.S3Client")
    static class S3ProviderConfiguration {
        @Bean
        @ConditionalOnMissingBean(StorageProvider.class)
        StorageProvider psoS3StorageProvider(PsoProperties props) {
            PsoProperties.StorageS3 s3 = props.getStorage().getS3();
            if (s3.getBucket() == null || s3.getBucket().isBlank()) {
                throw new IllegalStateException("pso.storage.s3.bucket is required when pso.storage.provider=s3");
            }
            var common = new S3Factory(s3);
            var presigner = props.getStorage().getSignedUrl().isEnabled() ? common.presigner() : null;
            return new S3StorageProvider(common.client(), presigner, s3.getBucket(), s3.getPrefix());
        }
    }

    /** Isolates the SDK types so this class is only loaded when the SDK is on the classpath. */
    static final class S3Factory {
        private final PsoProperties.StorageS3 s3;

        S3Factory(PsoProperties.StorageS3 s3) {
            this.s3 = s3;
        }

        software.amazon.awssdk.services.s3.S3Client client() {
            var b = software.amazon.awssdk.services.s3.S3Client.builder().credentialsProvider(software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider.builder().build());
            if (s3.getRegion() != null && !s3.getRegion().isBlank()) {
                b.region(software.amazon.awssdk.regions.Region.of(s3.getRegion()));
            }
            if (s3.getEndpoint() != null && !s3.getEndpoint().isBlank()) {
                b.endpointOverride(URI.create(s3.getEndpoint()));
            }
            return b.forcePathStyle(s3.isPathStyleAccess()).build();
        }

        software.amazon.awssdk.services.s3.presigner.S3Presigner presigner() {
            var b = software.amazon.awssdk.services.s3.presigner.S3Presigner.builder().credentialsProvider(software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider.builder().build());
            if (s3.getRegion() != null && !s3.getRegion().isBlank()) {
                b.region(software.amazon.awssdk.regions.Region.of(s3.getRegion()));
            }
            if (s3.getEndpoint() != null && !s3.getEndpoint().isBlank()) {
                b.endpointOverride(URI.create(s3.getEndpoint()));
            }
            return b.build();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.storage", name = "provider", havingValue = "s3")
    @ConditionalOnMissingClass("software.amazon.awssdk.services.s3.S3Client")
    static class S3SdkMissingConfiguration {
        @Bean
        StorageProvider psoS3SdkMissing() {
            throw new IllegalStateException("pso.storage.provider=s3 needs the AWS SDK on the classpath: add software.amazon.awssdk:s3 to the service's dependencies");
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.storage", name = "provider", havingValue = "azure")
    @ConditionalOnClass(name = "com.azure.storage.blob.BlobServiceClient")
    static class AzureProviderConfiguration {
        @Bean
        @ConditionalOnMissingBean(StorageProvider.class)
        StorageProvider psoAzureStorageProvider(PsoProperties props, Environment env) {
            PsoProperties.StorageAzure az = props.getStorage().getAzure();
            if (az.getContainer() == null || az.getContainer().isBlank()) {
                throw new IllegalStateException("pso.storage.azure.container is required when pso.storage.provider=azure");
            }
            boolean conn = az.getConnectionString() != null && !az.getConnectionString().isBlank();
            if (!conn && (az.getEndpoint() == null || az.getEndpoint().isBlank())) {
                throw new IllegalStateException("pso.storage.azure.endpoint is required (managed identity / DefaultAzureCredential); a connection string is accepted for local emulators only");
            }
            if (conn) {
                for (String p : env.getActiveProfiles()) {
                    if (p.equals("prod") || p.equals("staging")) {
                        throw new IllegalStateException("pso.storage.azure.connection-string is not allowed with the \"" + p + "\" profile: use pso.storage.azure.endpoint with a managed identity");
                    }
                }
                LOG.warn("Azure Blob Storage is using a connection string (an account key): acceptable for Azurite and local work only");
            }
            var factory = new AzureFactory(az, conn);
            return new AzureBlobStorageProvider(factory.container(), factory.service(), conn, az.getPrefix(), az.getCopyTimeout());
        }
    }

    /** Isolates the SDK types. */
    static final class AzureFactory {
        private final PsoProperties.StorageAzure az;
        private final boolean conn;

        AzureFactory(PsoProperties.StorageAzure az, boolean conn) {
            this.az = az;
            this.conn = conn;
        }

        com.azure.storage.blob.BlobServiceClient service() {
            var b = new com.azure.storage.blob.BlobServiceClientBuilder();
            if (conn) {
                b.connectionString(az.getConnectionString());
            } else {
                b.endpoint(az.getEndpoint()).credential(new com.azure.identity.DefaultAzureCredentialBuilder().build());
            }
            return b.buildClient();
        }

        com.azure.storage.blob.BlobContainerClient container() {
            return service().getBlobContainerClient(az.getContainer());
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.storage", name = "provider", havingValue = "azure")
    @ConditionalOnMissingClass("com.azure.storage.blob.BlobServiceClient")
    static class AzureSdkMissingConfiguration {
        @Bean
        StorageProvider psoAzureSdkMissing() {
            throw new IllegalStateException("pso.storage.provider=azure needs the Azure SDK on the classpath: add com.azure:azure-storage-blob and com.azure:azure-identity to the service's dependencies");
        }
    }

    // ------------------------------------------------------------------ framework beans
    @Bean
    @ConditionalOnMissingBean(FileMetadataStore.class)
    FileMetadataStore psoFileMetadataStore(StorageProvider provider, PsoProperties props) {
        if (props.getStorage().getMetadata().getStore() == PsoProperties.StorageMetadataStore.MEMORY) {
            LOG.warn("pso.storage.metadata.store=memory: file records are lost on restart and not shared between instances (tests only)");
            return new FileMetadataStore.InMemory();
        }
        return new FileMetadataStore.ProviderBacked(provider);
    }

    @Bean
    @ConditionalOnMissingBean(StorageAccess.Policy.class)
    StorageAccess.Policy psoStorageAccessPolicy() {
        return StorageAccess.OWNER_ONLY;
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.springframework.security.core.context.SecurityContextHolder")
    static class SecurityCallerConfiguration {
        @Bean
        @ConditionalOnMissingBean(StorageAccess.CallerResolver.class)
        StorageAccess.CallerResolver psoStorageCallerResolver() {
            return new SecurityContextCallerResolver();
        }
    }

    @Bean
    @ConditionalOnMissingBean(StorageAccess.CallerResolver.class)
    StorageAccess.CallerResolver psoNoCallerResolver() {
        return () -> null; // without Spring Security the caller must be passed explicitly (or provide a CallerResolver bean)
    }

    @Bean
    @ConditionalOnMissingBean
    PsoStorageService psoStorageService(StorageProvider provider, FileMetadataStore metadata, StorageAccess.Policy policy, StorageAccess.CallerResolver resolver,
                                        ObjectProvider<ContentScanner> scanner, ApplicationEventPublisher events, PsoProperties props) {
        PsoProperties.Storage s = props.getStorage();
        ContentScanner cs = scanner.getIfAvailable();
        if (s.getScan().isRequired() && cs == null) {
            throw new IllegalStateException("pso.storage.scan.required=true but no ContentScanner bean is configured: the framework ships no scanning engine, register one or set it to false");
        }
        long max = s.getUpload().getMaxSize().toBytes();
        if (max <= 0) {
            throw new IllegalStateException("pso.storage.upload.max-size must be positive");
        }
        PsoProperties.Multipart mp = props.getLimits().getMultipart();
        if (!mp.isEnabled()) {
            LOG.info("pso.storage is active but pso.limits.multipart.enabled is false: multipart uploads are refused (415) until you enable it");
        } else if (max > mp.getMaxFileSize().toBytes()) {
            LOG.warn("pso.storage.upload.max-size ({} bytes) is larger than pso.limits.multipart.max-file-size ({} bytes): the container will refuse files above the smaller limit", max, mp.getMaxFileSize().toBytes());
        }
        if (cs == null) {
            LOG.info("no ContentScanner bean: uploads are validated (size, type, signature) but NOT scanned for malware");
        }
        var up = new UploadPolicy(max, Set.copyOf(s.getUpload().getAllowedContentTypes()), Set.copyOf(s.getUpload().getAllowedExtensions()), s.getUpload().isAllowUnverifiedTypes());
        var sg = s.getSignedUrl();
        if (sg.getMaxTtl().compareTo(sg.getDefaultTtl()) < 0 || sg.getDefaultTtl().isZero() || sg.getDefaultTtl().isNegative()) {
            throw new IllegalStateException("pso.storage.signed-url: default-ttl must be positive and not greater than max-ttl");
        }
        LOG.info("PSO storage ready: provider={} metadata={} maxSize={} bytes signedUrls={}", provider.name(), s.getMetadata().getStore(), max, sg.isEnabled());
        return new PsoStorageService(provider, metadata, policy, resolver, cs, events,
            new PsoStorageService.Settings(up, sg.isEnabled(), sg.getDefaultTtl(), sg.getMaxTtl(), s.getScan().isRequired()), Clock.systemUTC());
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    static class WebConfiguration {
        @Bean
        @ConditionalOnMissingBean(StorageProblemAdvice.class)
        StorageProblemAdvice psoStorageProblemAdvice() {
            return new StorageProblemAdvice();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(HealthIndicator.class)
    static class HealthConfiguration {
        @Bean
        @ConditionalOnMissingBean(name = "psoStorageHealthIndicator")
        HealthIndicator psoStorageHealthIndicator(StorageProvider provider) {
            return () -> {
                try {
                    provider.healthCheck();
                    return Health.up().withDetail("provider", provider.name()).build();
                } catch (RuntimeException e) {
                    return Health.down().withDetail("provider", provider.name()).build(); // never the cause: it may name buckets or paths
                }
            };
        }
    }
}
