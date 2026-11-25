package com.pso.spring.storage.provider;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageProvider;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Real filesystem, no mocks: the local provider is what self-hosted deployments run. */
class LocalFileSystemProviderTests {

    @TempDir
    Path dir;
    Path root;
    LocalFileSystemProvider provider;

    @BeforeEach
    void setUp() {
        root = dir.resolve("storage");
        provider = new LocalFileSystemProvider(root);
    }

    private static InputStream in(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(InputStream in) throws IOException {
        try (in) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private long countFiles() throws IOException {
        try (Stream<Path> s = Files.walk(root.toRealPath())) {
            return s.filter(Files::isRegularFile).count();
        }
    }

    @Test
    void storesAndReadsBackWithoutExposingThePath() throws IOException {
        StorageProvider.ObjectInfo info = provider.put("hr/42/f_abc", in("hello"), 5, "text/plain", Map.of());
        assertThat(info.key()).isEqualTo("hr/42/f_abc");
        assertThat(info.size()).isEqualTo(5);
        assertThat(read(provider.get("hr/42/f_abc"))).isEqualTo("hello");
        assertThat(provider.stat("hr/42/f_abc")).isPresent();
        assertThat(provider.exists("hr/42/nope")).isFalse();
        assertThat(info.toString()).doesNotContain(root.toString());
    }

    @Test
    void neverOverwritesAnExistingObject() throws IOException {
        provider.put("a/b", in("first"), -1, null, Map.of());
        assertThatThrownBy(() -> provider.put("a/b", in("second"), -1, null, Map.of())).isInstanceOf(StorageException.Conflict.class);
        assertThat(read(provider.get("a/b"))).isEqualTo("first");
    }

    @Test
    void rejectsTraversalAbsolutePathsAndOddKeys() {
        for (String key : List.of("../x", "a/../../x", "/etc/passwd", "a//b", "a/./b", "C:/Windows/win.ini", "a\\b", "a/b/", "", ".hidden", "a/..", "a/b.", "x".repeat(600), "a/\u0000b", "a/%2e%2e/b")) {
            assertThatThrownBy(() -> provider.put(key, in("x"), 1, null, Map.of())).as("key %s", key).isInstanceOf(StorageException.Invalid.class);
            assertThatThrownBy(() -> provider.get(key)).as("get %s", key).isInstanceOf(StorageException.Invalid.class);
            assertThatThrownBy(() -> provider.delete(key)).as("delete %s", key).isInstanceOf(StorageException.Invalid.class);
        }
        assertThat(dir.resolve("x")).doesNotExist();
    }

    @Test
    void refusesToFollowASymbolicLinkOutOfTheRoot() throws IOException {
        Path outside = Files.createDirectory(dir.resolve("outside"));
        Files.writeString(outside.resolve("secret.txt"), "top secret");
        Path link = root.toRealPath().resolve("escape");
        try {
            Files.createSymbolicLink(link, outside);
        } catch (IOException | UnsupportedOperationException | SecurityException e) {
            assumeTrue(false, "this platform/user cannot create symbolic links (Windows needs developer mode or elevation): " + e.getClass().getSimpleName());
        }
        assertThatThrownBy(() -> provider.get("escape/secret.txt")).isInstanceOf(StorageException.Invalid.class).hasMessageContaining("symbolic link");
        assertThatThrownBy(() -> provider.put("escape/new.txt", in("x"), 1, null, Map.of())).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> provider.delete("escape/secret.txt")).isInstanceOf(StorageException.Invalid.class);
        assertThat(outside.resolve("secret.txt")).exists();
        assertThat(outside.resolve("new.txt")).doesNotExist();
        // a link planted AS the final component is not followed either
        Path fileLink = root.toRealPath().resolve("leaf");
        Files.createSymbolicLink(fileLink, outside.resolve("secret.txt"));
        assertThatThrownBy(() -> provider.get("leaf")).isInstanceOf(StorageException.Invalid.class);
    }

    @Test
    void refusesADirectoryJunctionOrAnyRedirection() throws IOException, InterruptedException {
        assumeTrue(System.getProperty("os.name").toLowerCase().contains("win"), "junctions exist on Windows only");
        Path outside = Files.createDirectory(dir.resolve("outside-j"));
        Files.writeString(outside.resolve("secret.txt"), "top secret");
        Path junction = root.toRealPath().resolve("jct");
        Process p = new ProcessBuilder("cmd", "/c", "mklink", "/J", junction.toString(), outside.toString()).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        assumeTrue(p.waitFor() == 0 && Files.exists(junction), "could not create a junction");
        assertThatThrownBy(() -> provider.get("jct/secret.txt")).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> provider.put("jct/new.txt", in("x"), 1, null, Map.of())).isInstanceOf(StorageException.Invalid.class);
        assertThat(outside.resolve("new.txt")).doesNotExist();
    }

    @Test
    void aFailedOrInterruptedWriteLeavesNothingBehind() throws IOException {
        InputStream broken = new InputStream() {
            int n;

            @Override
            public int read() throws IOException {
                if (n++ > 100) {
                    throw new IOException("connection reset");
                }
                return 'x';
            }
        };
        assertThatThrownBy(() -> provider.put("docs/f_1", broken, -1, null, Map.of())).isInstanceOf(StorageException.Unavailable.class);
        assertThat(provider.exists("docs/f_1")).isFalse();
        assertThat(countFiles()).as("no partial object and no temp file").isZero();
        // a size limit raised by the stream itself propagates untouched (the service reports it as 413) and also leaves nothing
        InputStream big = new InputStream() {
            @Override
            public int read() {
                throw new StorageException.TooLarge(10);
            }
        };
        assertThatThrownBy(() -> provider.put("docs/f_2", big, -1, null, Map.of())).isInstanceOf(StorageException.TooLarge.class);
        assertThat(countFiles()).isZero();
    }

    @Test
    void copyAndMoveNeverOverwrite() throws IOException {
        provider.put("a/one", in("1"), 1, null, Map.of());
        provider.put("a/two", in("2"), 1, null, Map.of());
        provider.copy("a/one", "b/copy");
        assertThat(read(provider.get("b/copy"))).isEqualTo("1");
        assertThat(provider.exists("a/one")).isTrue();
        assertThatThrownBy(() -> provider.copy("a/one", "a/two")).isInstanceOf(StorageException.Conflict.class);
        assertThatThrownBy(() -> provider.copy("a/missing", "a/new")).isInstanceOf(StorageException.NotFound.class);
        provider.move("a/one", "c/d/moved");
        assertThat(provider.exists("a/one")).isFalse();
        assertThat(read(provider.get("c/d/moved"))).isEqualTo("1");
        assertThatThrownBy(() -> provider.move("a/two", "c/d/moved")).isInstanceOf(StorageException.Conflict.class);
        assertThat(read(provider.get("a/two"))).isEqualTo("2");
        assertThat(provider.atomicMove()).isTrue();
    }

    @Test
    void deleteIsIdempotentAndPrunesEmptyFolders() throws IOException {
        provider.put("x/y/z", in("1"), 1, null, Map.of());
        provider.delete("x/y/z");
        provider.delete("x/y/z");
        assertThat(root.toRealPath().resolve("x")).doesNotExist();
        assertThat(root).exists();
    }

    @Test
    void listsInKeyOrderWithPagination() {
        for (int i = 0; i < 7; i++) {
            provider.put("list/k" + i, in("v"), 1, null, Map.of());
        }
        provider.put("other/z", in("v"), 1, null, Map.of());
        StorageProvider.ObjectPage p1 = provider.list("list/", null, 3);
        assertThat(p1.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("list/k0", "list/k1", "list/k2");
        assertThat(p1.nextCursor()).isNotNull();
        StorageProvider.ObjectPage p2 = provider.list("list/", p1.nextCursor(), 3);
        assertThat(p2.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("list/k3", "list/k4", "list/k5");
        StorageProvider.ObjectPage p3 = provider.list("list/", p2.nextCursor(), 3);
        assertThat(p3.items()).extracting(StorageProvider.ObjectInfo::key).containsExactly("list/k6");
        assertThat(p3.nextCursor()).isNull();
        assertThat(provider.list("", null, 100).items()).extracting(StorageProvider.ObjectInfo::key).doesNotContain(".pso-tmp");
    }

    @Test
    void createsOwnerOnlyPermissionsWhereSupported() throws IOException {
        assumeTrue(java.nio.file.FileSystems.getDefault().supportedFileAttributeViews().contains("posix"), "POSIX file permissions do not exist on this file system (Windows)");
        provider.put("p/f", in("x"), 1, null, Map.of());
        assertThat(java.nio.file.attribute.PosixFilePermissions.toString(provider.permissionsOf("p/f"))).isEqualTo("rw-------");
    }

    @Test
    void replaceIsAtomicAndOnlyForMetadataRecords() throws IOException {
        provider.put("_pso/files/f_x.json", in("v1"), 2, null, Map.of());
        provider.replace("_pso/files/f_x.json", in("v2"), 2, null, Map.of());
        assertThat(read(provider.get("_pso/files/f_x.json"))).isEqualTo("v2");
    }

    @Test
    void sweepsStaleTemporaryFilesAtStartUp() throws IOException {
        Path stale = Files.createFile(root.toRealPath().resolve(".pso-tmp").resolve("up-stale.part"));
        Files.setLastModifiedTime(stale, java.nio.file.attribute.FileTime.from(java.time.Instant.now().minus(java.time.Duration.ofHours(3))));
        Path fresh = Files.createFile(root.toRealPath().resolve(".pso-tmp").resolve("up-fresh.part"));
        new LocalFileSystemProvider(root);
        assertThat(stale).doesNotExist();
        assertThat(fresh).exists();
    }

    @Test
    void healthCheckFailsWhenTheRootDisappears() throws IOException {
        provider.healthCheck();
        try (Stream<Path> s = Files.walk(root.toRealPath())) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
        assertThatThrownBy(provider::healthCheck).isInstanceOf(StorageException.Unavailable.class);
    }
}
