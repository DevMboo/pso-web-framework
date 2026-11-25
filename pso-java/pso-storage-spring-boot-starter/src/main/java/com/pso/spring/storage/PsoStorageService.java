package com.pso.spring.storage;

import com.pso.spring.storage.StorageAccess.Caller;
import com.pso.spring.storage.StorageAccess.Operation;
import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;

/**
 * The storage API an application uses. It composes a {@link StorageProvider} (bytes), a {@link FileMetadataStore} (records) and a
 * {@link StorageAccess.Policy} (business authorization) so that no microservice reimplements any of it:
 *
 * <ul>
 *   <li>identifiers are opaque and random ({@code f_...}); the storage key is generated from a validated namespace and the id,
 *       never from the client's filename;</li>
 *   <li>possessing an id grants nothing: every operation asks the policy first (the default is owner-only);</li>
 *   <li>uploads are validated (size while streaming, declared type, extension, signature) before the first byte is stored, and scanned
 *       when a {@link ContentScanner} is registered;</li>
 *   <li>every operation, allowed or denied, publishes a {@link StorageAuditEvent} (identifiers only).</li>
 * </ul>
 *
 * <p>Object stores give no transaction across objects: {@code store} deletes the object if the record cannot be saved; {@code move} copies,
 * saves the record, then deletes the old object, so a crash leaves at worst an orphaned object, never a record pointing at nothing.
 */
public class PsoStorageService {

    private static final Logger LOG = LoggerFactory.getLogger(PsoStorageService.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern CONTEXT_KEY = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    public static final int MAX_PAGE = 200;

    /** Operational settings (from {@code pso.storage.*}). */
    public record Settings(UploadPolicy upload, boolean signedUrlsEnabled, Duration signedUrlDefaultTtl, Duration signedUrlMaxTtl, boolean scanRequired) {
    }

    public record ListQuery(String ownerRef, String namespace, String cursor, int limit) {
        public static ListQuery first(int limit) {
            return new ListQuery(null, null, null, limit);
        }
    }

    public record FilePage(List<StoredFile> items, String nextCursor) {
    }

    /** An opened file: close it to release the provider stream. */
    public record FileContent(StoredFile file, InputStream stream) implements Closeable {
        @Override
        public void close() throws IOException {
            stream.close();
        }
    }

    private final StorageProvider provider;
    private final FileMetadataStore metadata;
    private final StorageAccess.Policy policy;
    private final StorageAccess.CallerResolver resolver;
    private final ContentScanner scanner;
    private final ApplicationEventPublisher events;
    private final Settings settings;
    private final Clock clock;

    public PsoStorageService(StorageProvider provider, FileMetadataStore metadata, StorageAccess.Policy policy, StorageAccess.CallerResolver resolver,
                             ContentScanner scanner, ApplicationEventPublisher events, Settings settings, Clock clock) {
        this.provider = provider;
        this.metadata = metadata;
        this.policy = policy;
        this.resolver = resolver;
        this.scanner = scanner;
        this.events = events;
        this.settings = settings;
        this.clock = clock;
    }

    public StorageProvider provider() {
        return provider;
    }

    /** The caller of the current request, from the configured resolver (Spring Security by default). */
    public Caller currentCaller() {
        Caller c = resolver == null ? null : resolver.current();
        if (c == null || c.subject() == null || c.subject().isBlank()) {
            throw new StorageException.AccessDenied("no authenticated caller");
        }
        return c;
    }

    // ------------------------------------------------------------------ store
    public StoredFile store(Caller caller, StorageRequest request) {
        try (InputStream raw = request.content()) {
            return doStore(caller, request, raw);
        } catch (IOException e) {
            throw new StorageException.Unavailable("cannot read the upload", e);
        }
    }

    private StoredFile doStore(Caller caller, StorageRequest req, InputStream raw) throws IOException {
        String filename = SafeFileNames.sanitize(req.filename());
        String namespace = StorageKeys.namespace(req.namespace());
        Map<String, String> context = validContext(req.context());
        String declared = FileSignatures.normalize(req.contentType());
        if (declared.isEmpty()) {
            declared = "application/octet-stream";
        }
        UploadPolicy base = settings.upload();
        UploadPolicy own = req.policy();
        long limit = own == null ? base.maxSize() : Math.min(base.maxSize(), own.maxSize());
        StoredFile prospective = new StoredFile(null, filename, null, declared, -1, provider.name(), clock.instant(), caller == null ? null : caller.subject(), req.ownerRef(), null, context);
        authorize(Operation.STORE, caller, prospective, null);
        if (settings.scanRequired() && scanner == null) {
            throw new StorageException.Unavailable("content scanning is required but no ContentScanner is configured", null);
        }
        if (req.contentLength() > limit) {
            audit(Operation.STORE, null, caller, "FAILED", "too-large");
            throw new StorageException.TooLarge(limit);
        }
        String id = newId();
        String key = StorageKeys.join(namespace, id);
        StorageKeys.requireValid(key);

        MessageDigest sha = sha256();
        Counting counting = new Counting(raw, limit);
        BufferedInputStream in = new BufferedInputStream(new DigestInputStream(counting, sha), FileSignatures.HEAD_BYTES * 2);
        byte[] head;
        try {
            in.mark(FileSignatures.HEAD_BYTES + 1);
            head = in.readNBytes(FileSignatures.HEAD_BYTES);
            in.reset();
        } catch (RuntimeException e) {
            throw failed(caller, e);
        }
        try {
            if (head.length == 0) {
                throw new StorageException.Invalid("file", "must not be empty");
            }
            base.check(filename, declared, head);
            if (own != null) {
                own.check(filename, declared, head);
            }
        } catch (StorageException.Invalid e) {
            audit(Operation.STORE, null, caller, "FAILED", "invalid");
            throw e;
        }
        try {
            provider.put(key, in, req.contentLength(), declared, Map.of());
        } catch (RuntimeException e) {
            throw failed(caller, e);
        }
        long size = counting.count();
        String checksum = HexFormat.of().formatHex(sha.digest());

        if (scanner != null) {
            ContentScanner.Verdict verdict;
            try {
                verdict = scanner.scan(new ContentScanner.Target(filename, declared, size, () -> provider.get(key)));
            } catch (RuntimeException e) {
                verdict = new ContentScanner.Verdict.Failed("scanner threw " + e.getClass().getSimpleName());
            }
            if (verdict instanceof ContentScanner.Verdict.Infected inf) {
                quietDelete(key);
                LOG.warn("storage upload rejected by the content scanner (signature {})", inf.signature());
                audit(Operation.STORE, null, caller, "FAILED", "scanner");
                throw new StorageException.Invalid("file", "was rejected by the content scanner");
            }
            if (verdict instanceof ContentScanner.Verdict.Failed f) {
                quietDelete(key);
                LOG.warn("storage upload refused: the content scanner could not decide ({})", f.reason());
                audit(Operation.STORE, null, caller, "FAILED", "scanner");
                throw new StorageException.Unavailable("content scanner unavailable", null);
            }
        }

        StoredFile file = new StoredFile(id, filename, key, declared, size, provider.name(), clock.instant(), caller.subject(), req.ownerRef(), checksum, context);
        try {
            metadata.save(file);
        } catch (RuntimeException e) {
            quietDelete(key); // no record, so nobody could ever reach the object: do not leave it behind
            throw failed(caller, e);
        }
        audit(Operation.STORE, id, caller, "ALLOWED", null);
        return file;
    }

    // ------------------------------------------------------------------ read
    public StoredFile metadata(Caller caller, String fileId) {
        StoredFile f = require(fileId, Operation.READ, caller);
        authorize(Operation.READ, caller, f, fileId);
        return f;
    }

    public FileContent open(Caller caller, String fileId) {
        StoredFile f = require(fileId, Operation.READ, caller);
        authorize(Operation.READ, caller, f, fileId);
        try {
            InputStream s = provider.get(f.key());
            audit(Operation.READ, fileId, caller, "ALLOWED", null);
            return new FileContent(f, s);
        } catch (StorageException.NotFound e) {
            audit(Operation.READ, fileId, caller, "FAILED", "object-missing");
            throw e;
        } catch (RuntimeException e) {
            throw failed(caller, fileId, Operation.READ, e);
        }
    }

    // ------------------------------------------------------------------ change
    public void delete(Caller caller, String fileId) {
        StoredFile f = require(fileId, Operation.DELETE, caller);
        authorize(Operation.DELETE, caller, f, fileId);
        try {
            provider.delete(f.key()); // object first: if the record removal fails, a retry finds nothing to delete and finishes the job
            metadata.delete(fileId);
        } catch (RuntimeException e) {
            throw failed(caller, fileId, Operation.DELETE, e);
        }
        audit(Operation.DELETE, fileId, caller, "ALLOWED", null);
    }

    /** Moves the file to another namespace; the id does not change. */
    public StoredFile move(Caller caller, String fileId, String destinationNamespace) {
        StoredFile f = require(fileId, Operation.MOVE, caller);
        authorize(Operation.MOVE, caller, f, fileId);
        String newKey = StorageKeys.join(StorageKeys.namespace(destinationNamespace), f.id());
        StorageKeys.requireValid(newKey);
        if (newKey.equals(f.key())) {
            return f;
        }
        StoredFile moved = f.withKey(newKey);
        try {
            if (provider.atomicMove()) {
                provider.move(f.key(), newKey);
                try {
                    metadata.save(moved);
                } catch (RuntimeException e) {
                    try {
                        provider.move(newKey, f.key());
                    } catch (RuntimeException undo) {
                        LOG.error("storage move could not be undone for file {}: the object is at its new key and the record still points to the old one", fileId);
                    }
                    throw e;
                }
            } else {
                provider.copy(f.key(), newKey);
                try {
                    metadata.save(moved);
                } catch (RuntimeException e) {
                    quietDelete(newKey);
                    throw e;
                }
                try {
                    provider.delete(f.key());
                } catch (RuntimeException e) {
                    LOG.warn("storage move of file {} succeeded but the old object could not be deleted (orphaned): {}", fileId, e.getClass().getSimpleName());
                }
            }
        } catch (RuntimeException e) {
            throw failed(caller, fileId, Operation.MOVE, e);
        }
        audit(Operation.MOVE, fileId, caller, "ALLOWED", null);
        return moved;
    }

    /** Copies the file into a new file (new id, uploaded by the caller). {@code ownerRef} null keeps the source's owner. */
    public StoredFile copy(Caller caller, String fileId, String destinationNamespace, String ownerRef) {
        StoredFile f = require(fileId, Operation.COPY, caller);
        authorize(Operation.COPY, caller, f, fileId);
        String id = newId();
        String key = StorageKeys.join(StorageKeys.namespace(destinationNamespace), id);
        StorageKeys.requireValid(key);
        StoredFile copy = new StoredFile(id, f.filename(), key, f.contentType(), f.size(), provider.name(), clock.instant(), caller.subject(),
            ownerRef == null ? f.ownerRef() : ownerRef, f.checksumSha256(), f.context());
        authorize(Operation.STORE, caller, new StoredFile(null, copy.filename(), null, copy.contentType(), copy.size(), copy.provider(), copy.createdAt(), copy.uploadedBy(), copy.ownerRef(), null, copy.context()), fileId);
        try {
            provider.copy(f.key(), key);
            try {
                metadata.save(copy);
            } catch (RuntimeException e) {
                quietDelete(key);
                throw e;
            }
        } catch (RuntimeException e) {
            throw failed(caller, fileId, Operation.COPY, e);
        }
        audit(Operation.COPY, id, caller, "ALLOWED", null);
        return copy;
    }

    // ------------------------------------------------------------------ list and signed access
    /**
     * One page of the files the caller may read. The page may be shorter than {@code limit} (records the caller may not read are omitted);
     * continue while {@code nextCursor} is not null.
     */
    public FilePage list(Caller caller, ListQuery query) {
        int limit = query.limit() <= 0 ? 50 : Math.min(query.limit(), MAX_PAGE);
        String ns = query.namespace() == null || query.namespace().isEmpty() ? null : StorageKeys.namespace(query.namespace());
        FileMetadataStore.Page page = metadata.list(new FileMetadataStore.Filter(query.ownerRef(), ns), query.cursor(), limit);
        List<StoredFile> visible = page.items().stream().filter(f -> policy.allows(Operation.READ, caller, f)).toList();
        return new FilePage(visible, page.nextCursor());
    }

    /**
     * A short-lived provider URL for direct client access. Only when {@code pso.storage.signed-url.enabled=true}, only for callers the policy
     * allows to SIGN, never for local storage (empty result: use the authenticated download route). The URL is a credential: do not log it.
     */
    public Optional<URI> signedUrl(Caller caller, String fileId, Duration ttl) {
        if (!settings.signedUrlsEnabled()) {
            throw new StorageException.Invalid("signedUrl", "signed URLs are not enabled (pso.storage.signed-url.enabled)");
        }
        StoredFile f = require(fileId, Operation.SIGN, caller);
        authorize(Operation.SIGN, caller, f, fileId);
        Duration effective = ttl == null ? settings.signedUrlDefaultTtl() : ttl;
        if (effective.isNegative() || effective.isZero() || effective.compareTo(settings.signedUrlMaxTtl()) > 0) {
            throw new StorageException.Invalid("ttl", "must be positive and at most " + settings.signedUrlMaxTtl());
        }
        try {
            Optional<URI> url = provider.signedUrl(f.key(), effective, new StorageProvider.SignedUrlOptions(f.filename(), ActiveContent.safeType(f.contentType())));
            audit(Operation.SIGN, fileId, caller, "ALLOWED", url.isPresent() ? null : "unsupported");
            return url;
        } catch (RuntimeException e) {
            throw failed(caller, fileId, Operation.SIGN, e);
        }
    }

    // ------------------------------------------------------------------ internals
    private StoredFile require(String fileId, Operation op, Caller caller) {
        Optional<StoredFile> f;
        try {
            f = metadata.find(fileId);
        } catch (RuntimeException e) {
            throw failed(caller, fileId, op, e);
        }
        if (f.isEmpty()) {
            audit(op, null, caller, "FAILED", "not-found");
            throw new StorageException.NotFound("no such file");
        }
        return f.get();
    }

    private void authorize(Operation op, Caller caller, StoredFile file, String fileId) {
        boolean ok;
        try {
            ok = policy.allows(op, caller, file);
        } catch (RuntimeException e) {
            ok = false; // a policy that throws denies
            LOG.warn("storage access policy threw {}: denied", e.getClass().getSimpleName());
        }
        if (!ok) {
            audit(op, fileId, caller, "DENIED", "policy");
            throw new StorageException.AccessDenied("the access policy denied " + op);
        }
    }

    private StorageException failed(Caller caller, RuntimeException e) {
        return failed(caller, null, Operation.STORE, e);
    }

    private StorageException failed(Caller caller, String fileId, Operation op, RuntimeException e) {
        StorageException.TooLarge big = StorageException.find(e, StorageException.TooLarge.class);
        if (big != null) {
            audit(op, fileId, caller, "FAILED", "too-large");
            return big;
        }
        if (e instanceof StorageException se) {
            audit(op, fileId, caller, "FAILED", se instanceof StorageException.Invalid ? "invalid" : se instanceof StorageException.Conflict ? "conflict" : "provider");
            return se;
        }
        LOG.warn("storage {} failed: {}", op, e.getClass().getName(), e);
        audit(op, fileId, caller, "FAILED", "provider");
        return new StorageException.Unavailable("the storage backend failed", e);
    }

    private void audit(Operation op, String fileId, Caller caller, String outcome, String reason) {
        StorageAuditEvent ev = new StorageAuditEvent(clock.instant(), op, fileId, caller == null ? null : caller.subject(), outcome, reason);
        LOG.info("storage audit operation={} file={} subject={} outcome={}{}", op, fileId, ev.subject(), outcome, reason == null ? "" : " reason=" + reason);
        if (events != null) {
            events.publishEvent(ev);
        }
    }

    private void quietDelete(String key) {
        try {
            provider.delete(key);
        } catch (RuntimeException e) {
            LOG.warn("storage cleanup could not delete an object: {}", e.getClass().getSimpleName());
        }
    }

    private static Map<String, String> validContext(Map<String, String> in) {
        if (in.size() > 16) {
            throw new StorageException.Invalid("context", "may have at most 16 entries");
        }
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : in.entrySet()) {
            if (!CONTEXT_KEY.matcher(e.getKey()).matches() || e.getValue() == null || e.getValue().length() > 256 || e.getValue().chars().anyMatch(Character::isISOControl)) {
                throw new StorageException.Invalid("context", "has an invalid entry");
            }
            out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    static String newId() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        return "f_" + Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Counts bytes and refuses to go past the limit: the check runs while the content streams, so an oversized upload is never stored. */
    private static final class Counting extends FilterInputStream {
        private final long limit;
        private long count;

        Counting(InputStream in, long limit) {
            super(in);
            this.limit = limit;
        }

        long count() {
            return count;
        }

        private int note(int n) {
            if (n > 0) {
                count += n;
                if (count > limit) {
                    throw new StorageException.TooLarge(limit);
                }
            }
            return n;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) {
                note(1);
            }
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            return note(super.read(b, off, len));
        }

        @Override
        public long skip(long n) throws IOException {
            return note((int) Math.min(Integer.MAX_VALUE, super.skip(n)));
        }

        @Override
        public boolean markSupported() {
            return false;
        }
    }
}
