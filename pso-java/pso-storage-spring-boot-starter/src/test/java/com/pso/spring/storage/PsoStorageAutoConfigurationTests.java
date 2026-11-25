package com.pso.spring.storage;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.storage.provider.LocalFileSystemProvider;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/** Provider selection, optional dependencies, validation messages and back-off. No cloud credentials are needed: nothing here reaches a network. */
class PsoStorageAutoConfigurationTests {

    final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(PsoAutoConfiguration.class, PsoStorageAutoConfiguration.class))
        .withPropertyValues("pso.service.name=docs-service");

    @Test
    void doesNothingWithoutAProvider_aServiceThatDoesNotUseFilesConfiguresNothing() {
        runner.run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).doesNotHaveBean(PsoStorageService.class).doesNotHaveBean(StorageProvider.class).doesNotHaveBean(FileMetadataStore.class);
        });
    }

    @Test
    void localProviderWiresTheWholeStack(@TempDir Path dir) {
        runner.withPropertyValues("pso.storage.provider=local", "pso.storage.local.root=" + dir.resolve("s")).run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(PsoStorageService.class);
            assertThat(ctx.getBean(StorageProvider.class)).isInstanceOf(LocalFileSystemProvider.class);
            assertThat(ctx.getBean(FileMetadataStore.class)).isInstanceOf(FileMetadataStore.ProviderBacked.class);
            assertThat(ctx.getBean(StorageAccess.Policy.class)).as("owner-only is the default").isSameAs(StorageAccess.OWNER_ONLY);
            assertThat(dir.resolve("s")).isDirectory();
        });
    }

    @Test
    void theApplicationCanReplaceEveryPiece(@TempDir Path dir) {
        StorageAccess.Policy mine = (op, c, f) -> true;
        FileMetadataStore store = new FileMetadataStore.InMemory();
        runner.withPropertyValues("pso.storage.provider=local", "pso.storage.local.root=" + dir.resolve("s"))
            .withBean("mine", StorageAccess.Policy.class, () -> mine).withBean(FileMetadataStore.class, () -> store).run(ctx -> {
                assertThat(ctx).hasNotFailed();
                assertThat(ctx.getBean(StorageAccess.Policy.class)).isSameAs(mine);
                assertThat(ctx.getBean(FileMetadataStore.class)).isSameAs(store);
            });
    }

    @Test
    void localWithoutARootFailsWithAMessageNamingTheProperty() {
        runner.withPropertyValues("pso.storage.provider=local").run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("pso.storage.local.root"));
    }

    @Test
    void s3AndAzureMissingValuesNameTheProperty() {
        runner.withPropertyValues("pso.storage.provider=s3").run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("pso.storage.s3.bucket"));
        runner.withPropertyValues("pso.storage.provider=azure").run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("pso.storage.azure.container"));
        runner.withPropertyValues("pso.storage.provider=azure", "pso.storage.azure.container=docs").run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("pso.storage.azure.endpoint"));
    }

    @Test
    void azureConnectionStringsAreRefusedInProductionProfiles() {
        runner.withPropertyValues("pso.storage.provider=azure", "pso.storage.azure.container=docs", "pso.storage.azure.connection-string=UseDevelopmentStorage=true", "spring.profiles.active=prod")
            .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("not allowed").hasMessageContaining("prod"));
    }

    @Test
    void anOptionalSdkThatIsMissingIsAClearStartupErrorNotAClassNotFound() {
        runner.withClassLoader(new FilteredClassLoader("software.amazon.awssdk")).withPropertyValues("pso.storage.provider=s3", "pso.storage.s3.bucket=b")
            .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("software.amazon.awssdk:s3"));
        runner.withClassLoader(new FilteredClassLoader("com.azure")).withPropertyValues("pso.storage.provider=azure", "pso.storage.azure.container=c", "pso.storage.azure.endpoint=https://x.blob.core.windows.net")
            .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("azure-storage-blob"));
    }

    @Test
    void s3AndAzureBuildTheirClientsWithoutCredentialsOrNetwork() {
        // client construction is lazy about credentials: the default provider chain is consulted per request, so nothing is needed to start
        runner.withPropertyValues("pso.storage.provider=s3", "pso.storage.s3.bucket=b", "pso.storage.s3.region=eu-west-1", "pso.storage.s3.prefix=t1")
            .run(ctx -> {
                assertThat(ctx).hasNotFailed();
                assertThat(ctx.getBean(StorageProvider.class).name()).isEqualTo("s3");
            });
        runner.withPropertyValues("pso.storage.provider=azure", "pso.storage.azure.container=c", "pso.storage.azure.endpoint=https://acct.blob.core.windows.net")
            .run(ctx -> {
                assertThat(ctx).hasNotFailed();
                assertThat(ctx.getBean(StorageProvider.class).name()).isEqualTo("azure");
            });
    }

    @Test
    void scanRequiredWithoutAScannerRefusesToStart(@TempDir Path dir) {
        runner.withPropertyValues("pso.storage.provider=local", "pso.storage.local.root=" + dir.resolve("s"), "pso.storage.scan.required=true")
            .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("no ContentScanner"));
        runner.withPropertyValues("pso.storage.provider=local", "pso.storage.local.root=" + dir.resolve("s2"), "pso.storage.scan.required=true")
            .withBean(ContentScanner.class, () -> t -> new ContentScanner.Verdict.Clean()).run(ctx -> assertThat(ctx).hasNotFailed());
    }

    @Test
    void invalidSettingsAreRejected(@TempDir Path dir) {
        String[] base = {"pso.storage.provider=local", "pso.storage.local.root=" + dir.resolve("s")};
        runner.withPropertyValues(base).withPropertyValues("pso.storage.signed-url.default-ttl=10m", "pso.storage.signed-url.max-ttl=1m")
            .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("default-ttl"));
        runner.withPropertyValues(base).withPropertyValues("pso.storage.provider=nonsense").run(ctx -> assertThat(ctx).hasFailed());
        runner.withPropertyValues(base).withPropertyValues("pso.storage.typo-key=1").run(ctx -> assertThat(ctx).hasFailed().getFailure().hasStackTraceContaining("typo"));
    }

    @Test
    void uploadLimitsAreBoundFromConfiguration(@TempDir Path dir) {
        runner.withPropertyValues("pso.storage.provider=local", "pso.storage.local.root=" + dir.resolve("s"), "pso.storage.upload.max-size=2KB", "pso.storage.upload.allowed-content-types=application/pdf",
            "pso.storage.upload.allowed-extensions=.pdf").run(ctx -> {
                PsoStorageService s = ctx.getBean(PsoStorageService.class);
                var caller = new StorageAccess.Caller("u1", java.util.Set.of());
                var big = new byte[3000];
                java.util.Arrays.fill(big, (byte) 'a');
                byte[] pdf = concat("%PDF-1.4\n".getBytes(), big);
                org.assertj.core.api.Assertions.assertThatThrownBy(() -> s.store(caller, StorageRequest.builder(new java.io.ByteArrayInputStream(pdf)).filename("a.pdf").contentType("application/pdf").build()))
                    .isInstanceOf(StorageException.TooLarge.class);
                byte[] small = concat("%PDF-1.4\n".getBytes(), new byte[100]);
                assertThat(s.store(caller, StorageRequest.builder(new java.io.ByteArrayInputStream(small)).filename("a.pdf").contentType("application/pdf").build()).size()).isEqualTo(small.length);
                org.assertj.core.api.Assertions.assertThatThrownBy(() -> s.store(caller, StorageRequest.builder(new java.io.ByteArrayInputStream(small)).filename("a.txt").contentType("application/pdf").build()))
                    .isInstanceOf(StorageException.Invalid.class);
            });
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
