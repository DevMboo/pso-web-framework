package com.pso.spring.storage.provider;

import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageKeys;
import com.pso.spring.storage.StorageProvider;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Local filesystem provider for development and self-hosted deployments.
 *
 * <p>A key is never a path chosen by a client: it is validated ({@link StorageKeys#requireValid}), resolved one segment at a time under the
 * real path of the storage root, and every existing component must be a plain directory or file inside the root (no symbolic links, no
 * junctions, no redirection of any kind). Writes go to a temporary file in {@code <root>/.pso-tmp}, are flushed to disk and then renamed into
 * place without replacing an existing file, so a crash or a failed upload never leaves a partial object under its key. Files are created with
 * owner-only permissions where the filesystem supports POSIX permissions. Absolute paths are never exposed.
 *
 * <p>The check-then-open sequence cannot be fully atomic against an attacker who can already write inside the root; the root must be a
 * directory only the service can write to. Listing walks the tree and is meant for development and small deployments.
 */
public final class LocalFileSystemProvider implements StorageProvider {

    private static final Logger LOG = LoggerFactory.getLogger(LocalFileSystemProvider.class);
    static final String TMP = ".pso-tmp";
    private static final Duration STALE_TEMP = Duration.ofHours(1);
    private static final boolean POSIX = java.nio.file.FileSystems.getDefault().supportedFileAttributeViews().contains("posix");

    private final Path root;
    private final Path tmp;

    public LocalFileSystemProvider(Path configuredRoot) {
        try {
            Files.createDirectories(configuredRoot);
            this.root = configuredRoot.toRealPath();
            if (!Files.isDirectory(root)) {
                throw new IllegalStateException("pso.storage.local.root is not a directory");
            }
            restrict(root, true);
            this.tmp = root.resolve(TMP);
            Files.createDirectories(tmp);
            restrict(tmp, true);
            sweepStaleTemporaryFiles();
        } catch (IOException e) {
            throw new IllegalStateException("pso.storage.local.root cannot be created or used: " + e.getClass().getSimpleName(), e);
        }
    }

    @Override
    public String name() {
        return "local";
    }

    @Override
    public boolean atomicMove() {
        return true;
    }

    // ------------------------------------------------------------------ path safety
    /** Resolves {@code key} under the root, refusing anything that is not an ordinary path inside it. Parents are created when asked. */
    private Path resolve(String key, boolean createParents) {
        StorageKeys.requireValid(key);
        String[] segments = key.split("/");
        if (segments[0].equals(TMP)) {
            throw new StorageException.Invalid("key", "contains an invalid segment");
        }
        Path p = root;
        try {
            for (int i = 0; i < segments.length; i++) {
                p = p.resolve(segments[i]);
                boolean last = i == segments.length - 1;
                if (Files.exists(p, LinkOption.NOFOLLOW_LINKS)) {
                    requirePlain(p, segments[i], i + 1);
                    if (!last && !Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
                        throw new StorageException.Conflict("a parent of the key is a file");
                    }
                } else if (createParents && !last) {
                    Files.createDirectory(p);
                    restrict(p, true);
                }
            }
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        }
        if (!p.normalize().startsWith(root)) {
            throw new StorageException.Invalid("key", "resolves outside the storage root");
        }
        return p;
    }

    /** An existing component must be a real file or directory located exactly where the key says (no symlink, junction or mount redirection). */
    private void requirePlain(Path p, String segment, int depth) throws IOException {
        if (Files.isSymbolicLink(p)) {
            throw new StorageException.Invalid("key", "resolves through a symbolic link");
        }
        Path real = p.toRealPath();
        if (!real.startsWith(root) || real.getNameCount() != root.getNameCount() + depth || !real.getFileName().toString().equalsIgnoreCase(segment)) {
            throw new StorageException.Invalid("key", "resolves outside the storage root");
        }
    }

    private static void restrict(Path p, boolean directory) {
        if (!POSIX) {
            return; // ACL based filesystems: the root's own permissions apply
        }
        try {
            Files.setPosixFilePermissions(p, PosixFilePermissions.fromString(directory ? "rwx------" : "rw-------"));
        } catch (IOException | UnsupportedOperationException e) {
            LOG.debug("could not restrict permissions of a storage path: {}", e.getClass().getSimpleName());
        }
    }

    // ------------------------------------------------------------------ write
    @Override
    public ObjectInfo put(String key, InputStream content, long contentLength, String contentType, Map<String, String> metadata) {
        return write(key, content, false);
    }

    @Override
    public ObjectInfo replace(String key, InputStream content, long contentLength, String contentType, Map<String, String> metadata) {
        return write(key, content, true);
    }

    private ObjectInfo write(String key, InputStream content, boolean replace) {
        Path target = resolve(key, true);
        Path temp = null;
        try {
            temp = Files.createTempFile(tmp, "up-", ".part");
            restrict(temp, false);
            try (OutputStream out = Files.newOutputStream(temp, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
                content.transferTo(out);
            }
            try (FileChannel ch = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                ch.force(true);
            }
            commit(temp, target, replace);
            temp = null;
            return info(key, target);
        } catch (FileAlreadyExistsException e) {
            throw new StorageException.Conflict("an object already exists under this key");
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp); // an interrupted or refused write leaves nothing behind
                } catch (IOException ignored) {
                    // swept at the next start-up
                }
            }
        }
    }

    private static void commit(Path temp, Path target, boolean replace) throws IOException {
        if (replace) {
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } else {
            Files.move(temp, target); // no REPLACE_EXISTING: an existing file makes this fail instead of being overwritten
        }
    }

    // ------------------------------------------------------------------ read
    @Override
    public InputStream get(String key) {
        Path p = resolve(key, false);
        try {
            if (!Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
                throw new StorageException.NotFound("no such object");
            }
            return Files.newInputStream(p, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            throw new StorageException.NotFound("no such object");
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        }
    }

    @Override
    public Optional<ObjectInfo> stat(String key) {
        Path p = resolve(key, false);
        try {
            if (!Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
                return Optional.empty();
            }
            return Optional.of(info(key, p));
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        }
    }

    private static ObjectInfo info(String key, Path p) throws IOException {
        BasicFileAttributes a = Files.readAttributes(p, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        return new ObjectInfo(key, a.size(), null, null, a.lastModifiedTime().toInstant(), Map.of());
    }

    // ------------------------------------------------------------------ delete, copy, move
    @Override
    public void delete(String key) {
        Path p = resolve(key, false);
        try {
            Files.deleteIfExists(p);
            for (Path d = p.getParent(); d != null && !d.equals(root) && d.startsWith(root); d = d.getParent()) {
                try {
                    Files.delete(d); // prune folders left empty; stops at the first one that is not
                } catch (IOException notEmpty) {
                    break;
                }
            }
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        }
    }

    @Override
    public void copy(String sourceKey, String destinationKey) {
        Path src = resolve(sourceKey, false);
        Path dst = resolve(destinationKey, true);
        Path temp = null;
        try {
            if (!Files.isRegularFile(src, LinkOption.NOFOLLOW_LINKS)) {
                throw new StorageException.NotFound("no such object");
            }
            temp = Files.createTempFile(tmp, "cp-", ".part");
            restrict(temp, false);
            Files.copy(src, temp, StandardCopyOption.REPLACE_EXISTING);
            commit(temp, dst, false);
            temp = null;
        } catch (FileAlreadyExistsException e) {
            throw new StorageException.Conflict("an object already exists under the destination key");
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (IOException ignored) {
                    // swept at the next start-up
                }
            }
        }
    }

    @Override
    public void move(String sourceKey, String destinationKey) {
        Path src = resolve(sourceKey, false);
        Path dst = resolve(destinationKey, true);
        try {
            if (!Files.isRegularFile(src, LinkOption.NOFOLLOW_LINKS)) {
                throw new StorageException.NotFound("no such object");
            }
            if (Files.exists(dst, LinkOption.NOFOLLOW_LINKS)) {
                throw new StorageException.Conflict("an object already exists under the destination key");
            }
            try {
                Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(src, dst);
            }
            for (Path d = src.getParent(); d != null && !d.equals(root) && d.startsWith(root); d = d.getParent()) {
                try {
                    Files.delete(d);
                } catch (IOException notEmpty) {
                    break;
                }
            }
        } catch (FileAlreadyExistsException e) {
            throw new StorageException.Conflict("an object already exists under the destination key");
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        }
    }

    // ------------------------------------------------------------------ list
    @Override
    public ObjectPage list(String prefix, String cursor, int limit) {
        if (limit < 1) {
            throw new StorageException.Invalid("limit", "must be positive");
        }
        String pre = prefix == null ? "" : prefix;
        List<String> keys = new ArrayList<>();
        Path start = root;
        String dirPrefix = pre.contains("/") ? pre.substring(0, pre.lastIndexOf('/')) : "";
        if (!dirPrefix.isEmpty()) {
            StorageKeys.requireValid(dirPrefix);
            start = resolve(dirPrefix, false);
        }
        if (!Files.isDirectory(start, LinkOption.NOFOLLOW_LINKS)) {
            return new ObjectPage(List.of(), null);
        }
        try (Stream<Path> walk = Files.walk(start)) {
            walk.filter(p -> Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)).forEach(p -> {
                String key = root.relativize(p).toString().replace('\\', '/');
                if (!key.startsWith(TMP + "/") && key.startsWith(pre) && (cursor == null || key.compareTo(cursor) > 0)) {
                    keys.add(key);
                }
            });
        } catch (IOException e) {
            throw new StorageException.Unavailable("local storage failed", e);
        }
        keys.sort(Comparator.naturalOrder());
        List<ObjectInfo> items = new ArrayList<>();
        for (String k : keys.subList(0, Math.min(limit, keys.size()))) {
            try {
                items.add(info(k, root.resolve(k)));
            } catch (IOException e) {
                // removed while listing: skip
            }
        }
        String next = keys.size() > limit ? keys.get(limit - 1) : null;
        return new ObjectPage(items, next);
    }

    @Override
    public void healthCheck() {
        if (!Files.isDirectory(root) || !Files.isWritable(root)) {
            throw new StorageException.Unavailable("the storage root is not a writable directory", null);
        }
    }

    private void sweepStaleTemporaryFiles() {
        try (Stream<Path> s = Files.list(tmp)) {
            Instant cutoff = Instant.now().minus(STALE_TEMP);
            s.forEach(p -> {
                try {
                    if (Files.getLastModifiedTime(p, LinkOption.NOFOLLOW_LINKS).toInstant().isBefore(cutoff)) {
                        Files.deleteIfExists(p);
                    }
                } catch (IOException ignored) {
                    // best effort
                }
            });
        } catch (IOException ignored) {
            // best effort
        }
    }

    Set<PosixFilePermission> permissionsOf(String key) throws IOException {
        return POSIX ? Files.getPosixFilePermissions(resolve(key, false), LinkOption.NOFOLLOW_LINKS) : Set.of();
    }
}
