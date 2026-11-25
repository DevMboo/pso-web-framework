package com.pso.spring.storage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pso.spring.storage.StorageAccess.Caller;
import com.pso.spring.storage.StorageAccess.Operation;
import com.pso.spring.storage.provider.LocalFileSystemProvider;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The service on a real local provider with the default (provider-backed) metadata: the same composition a service gets from auto-configuration. */
class PsoStorageServiceTests {

    static final byte[] PDF = ("%PDF-1.7\n" + "a".repeat(500) + "\n%%EOF\n").getBytes(StandardCharsets.ISO_8859_1);
    static final byte[] PNG = concat(new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, new byte[64]);

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    @TempDir
    Path dir;
    LocalFileSystemProvider provider;
    FileMetadataStore store;
    List<StorageAuditEvent> audit = new ArrayList<>();
    PsoStorageService service;
    final org.springframework.context.ApplicationEventPublisher events = e -> audit.add((StorageAuditEvent) e);

    final Caller hr = new Caller("hr-1", Set.of("ROLE_HR"));
    final Caller alice = new Caller("alice", Set.of());
    final Caller mallory = new Caller("mallory", Set.of());

    @BeforeEach
    void setUp() {
        provider = new LocalFileSystemProvider(dir.resolve("storage"));
        store = new FileMetadataStore.ProviderBacked(provider);
        service = build(StorageAccess.OWNER_ONLY, null, UploadPolicy.of(1_000_000), false);
    }

    PsoStorageService build(StorageAccess.Policy policy, ContentScanner scanner, UploadPolicy up, boolean signed) {
        return new PsoStorageService(provider, store, policy, () -> null, scanner, events,
            new PsoStorageService.Settings(up, signed, Duration.ofMinutes(1), Duration.ofMinutes(5), false), Clock.systemUTC());
    }

    StorageRequest.Builder req(byte[] data, String name, String type) {
        return StorageRequest.builder(new ByteArrayInputStream(data)).filename(name).contentType(type).contentLength(data.length);
    }

    static String text(InputStream in) throws IOException {
        try (in) {
            return new String(in.readAllBytes(), StandardCharsets.ISO_8859_1);
        }
    }

    // ------------------------------------------------------------------ store / open
    @Test
    void storesWithAnOpaqueIdAGeneratedKeyAndSafeMetadata() throws IOException {
        StoredFile f = service.store(hr, req(PDF, "..\\..\\etc/Contrato Final.pdf", "application/pdf").ownerRef("employee:42").namespace("employees/42/documents").context("kind", "contract").build());
        assertThat(f.id()).matches("^f_[A-Za-z0-9_-]{22}$");
        assertThat(f.key()).isEqualTo("employees/42/documents/" + f.id());
        assertThat(f.key()).doesNotContain("Contrato").doesNotContain("..");
        assertThat(f.filename()).isEqualTo("Contrato Final.pdf");
        assertThat(f.uploadedBy()).isEqualTo("hr-1");
        assertThat(f.ownerRef()).isEqualTo("employee:42");
        assertThat(f.size()).isEqualTo(PDF.length);
        assertThat(f.checksumSha256()).hasSize(64);
        assertThat(f.provider()).isEqualTo("local");
        assertThat(f.context()).containsEntry("kind", "contract");
        assertThat(f.view().toString()).doesNotContain("employees/42/documents/f_").doesNotContain("local").doesNotContain("hr-1");
        try (PsoStorageService.FileContent c = service.open(hr, f.id())) {
            assertThat(text(c.stream())).isEqualTo(new String(PDF, StandardCharsets.ISO_8859_1));
        }
        assertThat(audit).extracting(StorageAuditEvent::operation).containsExactly(Operation.STORE, Operation.READ);
        assertThat(audit).allSatisfy(e -> assertThat(e.outcome()).isEqualTo("ALLOWED"));
    }

    @Test
    void idsAreUnique() {
        String a = service.store(hr, req(PDF, "a.pdf", "application/pdf").build()).id();
        String b = service.store(hr, req(PDF, "a.pdf", "application/pdf").build()).id();
        assertThat(a).isNotEqualTo(b);
    }

    // ------------------------------------------------------------------ authorization
    @Test
    void possessingAnIdGrantsNothing_crossUserAccessIsDeniedForEveryOperation() {
        StoredFile f = service.store(alice, req(PDF, "mine.pdf", "application/pdf").ownerRef("alice").build());
        audit.clear();
        assertThatThrownBy(() -> service.open(mallory, f.id())).isInstanceOf(StorageException.AccessDenied.class);
        assertThatThrownBy(() -> service.metadata(mallory, f.id())).isInstanceOf(StorageException.AccessDenied.class);
        assertThatThrownBy(() -> service.delete(mallory, f.id())).isInstanceOf(StorageException.AccessDenied.class);
        assertThatThrownBy(() -> service.move(mallory, f.id(), "stolen")).isInstanceOf(StorageException.AccessDenied.class);
        assertThatThrownBy(() -> service.copy(mallory, f.id(), "stolen", null)).isInstanceOf(StorageException.AccessDenied.class);
        assertThatThrownBy(() -> service.open(new Caller("", Set.of()), f.id())).isInstanceOf(StorageException.AccessDenied.class);
        assertThatThrownBy(() -> service.open(null, f.id())).isInstanceOf(StorageException.AccessDenied.class);
        assertThat(audit).hasSize(7).allSatisfy(e -> {
            assertThat(e.outcome()).isEqualTo("DENIED");
            assertThat(e.reason()).isEqualTo("policy");
        });
        assertThat(service.metadata(alice, f.id()).id()).isEqualTo(f.id());
        assertThat(provider.exists(f.key())).as("nothing was moved, copied or deleted").isTrue();
    }

    @Test
    void theApplicationOwnsBusinessAuthorization() {
        StorageAccess.Policy hrPolicy = (op, caller, file) -> caller != null && (caller.has("ROLE_HR") || StorageAccess.OWNER_ONLY.allows(op, caller, file));
        PsoStorageService hrService = build(hrPolicy, null, UploadPolicy.of(1_000_000), false);
        StoredFile f = hrService.store(alice, req(PDF, "mine.pdf", "application/pdf").ownerRef("alice").build());
        assertThat(hrService.metadata(hr, f.id()).id()).isEqualTo(f.id());
        assertThatThrownBy(() -> hrService.metadata(mallory, f.id())).isInstanceOf(StorageException.AccessDenied.class);
        StorageAccess.Policy throwing = (op, caller, file) -> {
            throw new IllegalStateException("policy bug");
        };
        assertThatThrownBy(() -> build(throwing, null, UploadPolicy.of(1000), false).store(hr, req(PDF, "a.pdf", "application/pdf").build())).as("a policy that throws denies").isInstanceOf(StorageException.AccessDenied.class);
    }

    @Test
    void listIsPaginatedAndShowsOnlyWhatTheCallerMayRead() {
        for (int i = 0; i < 5; i++) {
            service.store(alice, req(PDF, "a" + i + ".pdf", "application/pdf").ownerRef("alice").namespace("docs").build());
        }
        service.store(mallory, req(PDF, "m.pdf", "application/pdf").ownerRef("mallory").namespace("docs").build());
        List<String> seen = new ArrayList<>();
        String cursor = null;
        int pages = 0;
        do {
            PsoStorageService.FilePage page = service.list(alice, new PsoStorageService.ListQuery(null, "docs", cursor, 2));
            assertThat(page.items()).hasSizeLessThanOrEqualTo(2);
            page.items().forEach(f -> seen.add(f.id()));
            cursor = page.nextCursor();
            pages++;
        } while (cursor != null && pages < 20);
        assertThat(seen).hasSize(5).doesNotHaveDuplicates();
        assertThat(service.list(alice, new PsoStorageService.ListQuery("mallory", null, null, 50)).items()).as("alice cannot list mallory's files").isEmpty();
        assertThat(service.list(alice, new PsoStorageService.ListQuery(null, null, null, 10_000)).items()).hasSize(5);
    }

    // ------------------------------------------------------------------ upload validation
    @Test
    void validatesSizeWhileStreamingAndStoresNothingWhenExceeded() throws IOException {
        PsoStorageService small = build(StorageAccess.OWNER_ONLY, null, UploadPolicy.of(200), false);
        // lying about the length: the count is taken from the bytes
        StorageRequest lying = StorageRequest.builder(new ByteArrayInputStream(PDF)).filename("a.pdf").contentType("application/pdf").contentLength(10).build();
        assertThatThrownBy(() -> small.store(alice, lying)).isInstanceOf(StorageException.TooLarge.class);
        assertThatThrownBy(() -> small.store(alice, req(PDF, "a.pdf", "application/pdf").build())).isInstanceOf(StorageException.TooLarge.class);
        StorageRequest unknown = StorageRequest.builder(new ByteArrayInputStream(PDF)).filename("a.pdf").contentType("application/pdf").build();
        assertThatThrownBy(() -> small.store(alice, unknown)).isInstanceOf(StorageException.TooLarge.class);
        assertThat(files()).as("no object, no record, no temp file").isEmpty();
        assertThat(audit).extracting(StorageAuditEvent::reason).contains("too-large");
        // a per-call policy can only narrow the limit
        assertThatThrownBy(() -> service.store(alice, req(PDF, "a.pdf", "application/pdf").policy(UploadPolicy.of(100)).build())).isInstanceOf(StorageException.TooLarge.class);
        assertThat(service.store(alice, req(PDF, "a.pdf", "application/pdf").policy(UploadPolicy.of(50_000_000)).build()).size()).as("a looser per-call limit does not raise the hard one").isEqualTo(PDF.length);
    }

    @Test
    void doesNotTrustTheDeclaredTypeOrTheExtension() {
        PsoStorageService pdfOnly = build(StorageAccess.OWNER_ONLY, null, UploadPolicy.of(1_000_000).withContentTypes("application/pdf").withExtensions(".pdf"), false);
        assertThat(pdfOnly.store(alice, req(PDF, "ok.pdf", "application/pdf").build()).contentType()).isEqualTo("application/pdf");
        assertInvalid(pdfOnly, req(PNG, "x.pdf", "application/pdf"), "does not match its declared type");          // png content, pdf label
        assertInvalid(pdfOnly, req(PDF, "x.exe", "application/pdf"), "extensions");                                 // wrong extension
        assertInvalid(pdfOnly, req(PDF, "x.pdf", "image/png"), "not accepted");                                     // type not on the list
        assertInvalid(pdfOnly, req(PDF, "x.pdf", null), "not accepted");                                            // no declared type
        assertInvalid(pdfOnly, req("MZ\u0090\u0000".getBytes(StandardCharsets.ISO_8859_1), "x.pdf", "application/pdf"), "does not match");
        assertInvalid(pdfOnly, req(new byte[0], "x.pdf", "application/pdf"), "must not be empty");
        // even with no configured list, a known format cannot lie about itself
        assertInvalid(service, req(PNG, "x.pdf", "application/pdf"), "does not match its declared type");
        assertInvalid(service, req(PDF, "x.txt", "text/plain"), "does not match its declared type");   // a pdf declared as text
        // unknown types are refused when a list is set, unless the operator accepts the risk
        PsoStorageService custom = build(StorageAccess.OWNER_ONLY, null, UploadPolicy.of(1000).withContentTypes("application/x-custom"), false);
        assertInvalid(custom, req("abc".getBytes(), "a.bin", "application/x-custom"), "cannot be verified");
        PsoStorageService trusting = build(StorageAccess.OWNER_ONLY, null, new UploadPolicy(1000, Set.of("application/x-custom"), Set.of(), true), false);
        assertThat(trusting.store(alice, req("abc".getBytes(), "a.bin", "application/x-custom").build()).contentType()).isEqualTo("application/x-custom");
    }

    private void assertInvalid(PsoStorageService s, StorageRequest.Builder b, String message) {
        assertThatThrownBy(() -> s.store(alice, b.build())).isInstanceOf(StorageException.Invalid.class).hasMessageContaining(message);
    }

    @Test
    void rejectsUnsafeNamespacesContextAndTheReservedPrefix() {
        for (String ns : List.of("../x", "a/../b", "/abs", "a//b", "_pso/files", "a/_pso", "C:\\x", "x".repeat(100), "a/b/c/d/e/f/g/h/i")) {
            assertThatThrownBy(() -> service.store(alice, req(PDF, "a.pdf", "application/pdf").namespace(ns).build())).as(ns).isInstanceOf(StorageException.Invalid.class);
        }
        assertThatThrownBy(() -> service.store(alice, req(PDF, "a.pdf", "application/pdf").context("bad key!", "v").build())).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> service.store(alice, req(PDF, "a.pdf", "application/pdf").context("k", "line\nbreak").build())).isInstanceOf(StorageException.Invalid.class);
        assertThat(files()).isEmpty();
    }

    @Test
    void sanitizesFilenamesAndNeverUsesThemInKeys() {
        assertThat(SafeFileNames.sanitize("../../secret.txt")).isEqualTo("secret.txt");
        assertThat(SafeFileNames.sanitize("C:\\Users\\x\\a.pdf")).isEqualTo("a.pdf");
        assertThat(SafeFileNames.sanitize(".htaccess")).isEqualTo("htaccess");
        assertThat(SafeFileNames.sanitize("nul.txt")).isEqualTo("_nul.txt");
        assertThat(SafeFileNames.sanitize(null)).isEqualTo("file");
        assertThat(SafeFileNames.sanitize("a\u202egnp.exe")).isEqualTo("agnp.exe");
        assertThat(SafeFileNames.sanitize("na<me>:x|y?.pdf")).isEqualTo("na_me__x_y_.pdf");
        assertThat(SafeFileNames.sanitize("é".repeat(300) + ".pdf").getBytes(StandardCharsets.UTF_8)).hasSizeLessThanOrEqualTo(255);
        assertThat(SafeFileNames.sanitize("é".repeat(300) + ".pdf")).endsWith(".pdf");
    }

    // ------------------------------------------------------------------ scanner
    @Test
    void scannerIsAnIntegrationPoint_infectedAndUndecidableUploadsAreRemoved() {
        ContentScanner infected = t -> new ContentScanner.Verdict.Infected("Test.Signature");
        assertThatThrownBy(() -> build(StorageAccess.OWNER_ONLY, infected, UploadPolicy.of(100_000), false).store(alice, req(PDF, "a.pdf", "application/pdf").build()))
            .isInstanceOf(StorageException.Invalid.class).hasMessageContaining("content scanner");
        ContentScanner broken = t -> {
            throw new IllegalStateException("engine down");
        };
        assertThatThrownBy(() -> build(StorageAccess.OWNER_ONLY, broken, UploadPolicy.of(100_000), false).store(alice, req(PDF, "a.pdf", "application/pdf").build())).isInstanceOf(StorageException.Unavailable.class);
        assertThat(files()).as("fail closed: nothing stays stored").isEmpty();
        ContentScanner clean = t -> {
            try (InputStream in = t.open()) {
                assertThat(in.readAllBytes()).hasSize(PDF.length);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
            return new ContentScanner.Verdict.Clean();
        };
        assertThat(build(StorageAccess.OWNER_ONLY, clean, UploadPolicy.of(100_000), false).store(alice, req(PDF, "a.pdf", "application/pdf").build())).isNotNull();
    }

    @Test
    void scanRequiredWithoutAScannerRefusesUploads() {
        PsoStorageService s = new PsoStorageService(provider, store, StorageAccess.OWNER_ONLY, () -> null, null, events,
            new PsoStorageService.Settings(UploadPolicy.of(1000), false, Duration.ofMinutes(1), Duration.ofMinutes(5), true), Clock.systemUTC());
        assertThatThrownBy(() -> s.store(alice, req(PDF, "a.pdf", "application/pdf").build())).isInstanceOf(StorageException.Unavailable.class);
    }

    // ------------------------------------------------------------------ move / copy / delete
    @Test
    void moveKeepsTheIdChangesTheKeyAndLeavesNoOldObject() throws IOException {
        StoredFile f = service.store(hr, req(PDF, "c.pdf", "application/pdf").ownerRef("hr-1").namespace("inbox").build());
        StoredFile moved = service.move(hr, f.id(), "employees/42/documents");
        assertThat(moved.id()).isEqualTo(f.id());
        assertThat(moved.key()).isEqualTo("employees/42/documents/" + f.id());
        assertThat(provider.exists(f.key())).isFalse();
        assertThat(service.metadata(hr, f.id()).key()).isEqualTo(moved.key());
        try (PsoStorageService.FileContent c = service.open(hr, f.id())) {
            assertThat(text(c.stream())).hasSize(PDF.length);
        }
        assertThat(service.move(hr, f.id(), "employees/42/documents")).as("moving to where it already is is a no-op").isEqualTo(moved);
        assertThatThrownBy(() -> service.move(hr, f.id(), "../etc")).isInstanceOf(StorageException.Invalid.class);
    }

    @Test
    void moveOnAnObjectStoreStyleProviderCopiesSavesThenDeletes() {
        // the generic path (no atomic rename): wrap the local provider so atomicMove() is false
        StorageProvider generic = new DelegatingProvider(provider) {
            @Override
            public boolean atomicMove() {
                return false;
            }
        };
        FileMetadataStore s = new FileMetadataStore.InMemory();
        PsoStorageService svc = new PsoStorageService(generic, s, StorageAccess.OWNER_ONLY, () -> null, null, events,
            new PsoStorageService.Settings(UploadPolicy.of(1_000_000), false, Duration.ofMinutes(1), Duration.ofMinutes(5), false), Clock.systemUTC());
        StoredFile f = svc.store(hr, req(PDF, "c.pdf", "application/pdf").ownerRef("hr-1").namespace("a").build());
        StoredFile moved = svc.move(hr, f.id(), "b");
        assertThat(generic.exists(f.key())).isFalse();
        assertThat(generic.exists(moved.key())).isTrue();
        assertThat(s.find(f.id()).orElseThrow().key()).isEqualTo(moved.key());
    }

    @Test
    void aFailingRecordSaveNeverLeavesAnUnreachableObjectOrABrokenRecord() {
        FileMetadataStore failing = new FileMetadataStore.InMemory() {
            @Override
            public void save(StoredFile file) {
                throw new IllegalStateException("database down");
            }
        };
        PsoStorageService svc = new PsoStorageService(provider, failing, StorageAccess.OWNER_ONLY, () -> null, null, events,
            new PsoStorageService.Settings(UploadPolicy.of(1_000_000), false, Duration.ofMinutes(1), Duration.ofMinutes(5), false), Clock.systemUTC());
        assertThatThrownBy(() -> svc.store(alice, req(PDF, "a.pdf", "application/pdf").build())).isInstanceOf(StorageException.Unavailable.class);
        assertThat(files()).as("the object that nobody could reach was removed").isEmpty();
        // move: the old object and record stay valid
        StoredFile f = service.store(alice, req(PDF, "a.pdf", "application/pdf").ownerRef("alice").namespace("one").build());
        FileMetadataStore failOnMove = new FileMetadataStore.InMemory() {
            @Override
            public void save(StoredFile file) {
                if (file.key().startsWith("two/")) {
                    throw new IllegalStateException("database down");
                }
                super.save(file);
            }
        };
        failOnMove.save(f);
        PsoStorageService svc2 = new PsoStorageService(provider, failOnMove, StorageAccess.OWNER_ONLY, () -> null, null, events,
            new PsoStorageService.Settings(UploadPolicy.of(1_000_000), false, Duration.ofMinutes(1), Duration.ofMinutes(5), false), Clock.systemUTC());
        assertThatThrownBy(() -> svc2.move(alice, f.id(), "two")).isInstanceOf(StorageException.Unavailable.class);
        assertThat(provider.exists(f.key())).as("the original is intact").isTrue();
        assertThat(provider.exists("two/" + f.id())).as("the half-made copy was removed").isFalse();
        assertThat(failOnMove.find(f.id()).orElseThrow().key()).isEqualTo(f.key());
    }

    @Test
    void copyCreatesAnIndependentFile() throws IOException {
        StoredFile f = service.store(alice, req(PDF, "c.pdf", "application/pdf").ownerRef("alice").namespace("a").build());
        StoredFile copy = service.copy(alice, f.id(), "b", "alice");
        assertThat(copy.id()).isNotEqualTo(f.id());
        assertThat(copy.checksumSha256()).isEqualTo(f.checksumSha256());
        service.delete(alice, f.id());
        try (PsoStorageService.FileContent c = service.open(alice, copy.id())) {
            assertThat(text(c.stream())).hasSize(PDF.length);
        }
    }

    @Test
    void deleteRemovesObjectAndRecord_andIsNotFoundAfterwards() {
        StoredFile f = service.store(alice, req(PDF, "c.pdf", "application/pdf").ownerRef("alice").build());
        service.delete(alice, f.id());
        assertThat(provider.exists(f.key())).isFalse();
        assertThatThrownBy(() -> service.metadata(alice, f.id())).isInstanceOf(StorageException.NotFound.class);
        assertThatThrownBy(() -> service.delete(alice, f.id())).isInstanceOf(StorageException.NotFound.class);
        assertThatThrownBy(() -> service.open(alice, "f_" + "A".repeat(22))).isInstanceOf(StorageException.NotFound.class);
        assertThatThrownBy(() -> service.open(alice, "../../etc/passwd")).as("a malformed id is simply unknown").isInstanceOf(StorageException.NotFound.class);
        assertThatThrownBy(() -> service.open(alice, null)).isInstanceOf(StorageException.NotFound.class);
    }

    // ------------------------------------------------------------------ signed URLs
    @Test
    void signedUrlsAreOffByDefaultNeverFabricatedAndBounded() {
        StoredFile f = service.store(alice, req(PDF, "c.pdf", "application/pdf").ownerRef("alice").build());
        assertThatThrownBy(() -> service.signedUrl(alice, f.id(), null)).isInstanceOf(StorageException.Invalid.class).hasMessageContaining("not enabled");
        PsoStorageService on = build(StorageAccess.OWNER_ONLY, null, UploadPolicy.of(1_000_000), true);
        assertThat(on.signedUrl(alice, f.id(), Duration.ofSeconds(30))).as("local storage has no URL and none is invented").isEqualTo(Optional.<URI>empty());
        assertThatThrownBy(() -> on.signedUrl(alice, f.id(), Duration.ofHours(1))).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> on.signedUrl(alice, f.id(), Duration.ZERO)).isInstanceOf(StorageException.Invalid.class);
        assertThatThrownBy(() -> on.signedUrl(mallory, f.id(), null)).isInstanceOf(StorageException.AccessDenied.class);
    }

    @Test
    void activeContentIsNeverServedWithItsOwnType() {
        assertThat(ActiveContent.safeType("text/html; charset=utf-8")).isEqualTo("application/octet-stream");
        assertThat(ActiveContent.safeType("image/svg+xml")).isEqualTo("application/octet-stream");
        assertThat(ActiveContent.safeType("application/xhtml+xml")).isEqualTo("application/octet-stream");
        assertThat(ActiveContent.safeType("garbage")).isEqualTo("application/octet-stream");
        assertThat(ActiveContent.safeType("application/pdf")).isEqualTo("application/pdf");
        assertThat(ActiveContent.safeType("IMAGE/PNG")).isEqualTo("image/png");
    }

    private List<Path> files() {
        try (Stream<Path> s = Files.walk(dir.resolve("storage"))) {
            return s.filter(Files::isRegularFile).toList();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Test helper: delegates everything to another provider. */
    static class DelegatingProvider implements StorageProvider {
        private final StorageProvider d;

        DelegatingProvider(StorageProvider d) {
            this.d = d;
        }

        public String name() { return d.name(); }
        public ObjectInfo put(String k, InputStream c, long l, String t, Map<String, String> m) { return d.put(k, c, l, t, m); }
        public ObjectInfo replace(String k, InputStream c, long l, String t, Map<String, String> m) { return d.replace(k, c, l, t, m); }
        public InputStream get(String k) { return d.get(k); }
        public Optional<ObjectInfo> stat(String k) { return d.stat(k); }
        public void delete(String k) { d.delete(k); }
        public void copy(String s, String t) { d.copy(s, t); }
        public ObjectPage list(String p, String c, int l) { return d.list(p, c, l); }
    }
}
