package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.it.docs.DocsApp;
import com.pso.spring.storage.StorageAuditEvent;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.event.EventListener;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * PSO Storage in a real Spring Boot service, over real HTTP, with the local provider on a real directory and real JWT validation:
 * the employee-documents scenario. An HR user uploads a PDF (multipart), the framework validates and stores it, the response carries an
 * opaque identifier, an authorized user downloads it, an unauthorized one is denied, and HR can move and delete it.
 */
@SpringBootTest(classes = {DocsApp.class, StorageEndToEndTests.Audit.class}, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "pso.service.name=hr-service", "pso.limits.requests.per-minute=100000",
    "pso.limits.multipart.enabled=true", "pso.limits.multipart.max-file-size=2MB", "pso.limits.multipart.max-request-size=3MB",
    "pso.storage.provider=local", "pso.storage.upload.max-size=2MB"})
class StorageEndToEndTests extends Base {

    static final Path ROOT = createRoot();

    static Path createRoot() {
        try {
            return Files.createTempDirectory("pso-it-storage-");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void storage(DynamicPropertyRegistry r) {
        r.add("pso.storage.local.root", () -> ROOT.resolve("data").toString());
    }

    @TestConfiguration
    static class Audit {
        final List<StorageAuditEvent> events = new CopyOnWriteArrayList<>();

        @EventListener
        void on(StorageAuditEvent e) {
            events.add(e);
        }

        @Bean
        Audit.Holder holder() {
            return new Holder(events);
        }

        record Holder(List<StorageAuditEvent> events) {
        }
    }

    @Autowired
    Audit.Holder audit;

    static final ObjectMapper JSON = new ObjectMapper();
    static final byte[] PDF = ("%PDF-1.7\n" + "contract text ".repeat(100) + "\n%%EOF\n").getBytes(StandardCharsets.ISO_8859_1);

    // the actors
    String hr() {
        return JWT.token("hr-1", List.of("documents:write", "documents:read"), List.of("HR"));
    }

    String employee(String id) {
        return JWT.token(id, List.of("documents:read"), List.of());
    }

    String readerWithoutBusinessRights() {
        return JWT.token("someone-else", List.of("documents:read"), List.of());
    }

    // ------------------------------------------------------------------ multipart client
    record Part(String name, String filename, String type, byte[] data) {
        static Part text(String name, String value) {
            return new Part(name, null, null, value.getBytes(StandardCharsets.UTF_8));
        }

        static Part file(String name, String filename, String type, byte[] data) {
            return new Part(name, filename, type, data);
        }
    }

    HttpResponse<String> upload(String token, String employee, Part... parts) {
        String boundary = "----pso-it-" + UUID.randomUUID();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            for (Part p : parts) {
                out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + p.name + "\"" + (p.filename != null ? "; filename=\"" + p.filename + "\"" : "") + "\r\n"
                    + (p.type != null ? "Content-Type: " + p.type + "\r\n" : "") + "\r\n").getBytes(StandardCharsets.UTF_8));
                out.write(p.data);
                out.write("\r\n".getBytes());
            }
            out.write(("--" + boundary + "--\r\n").getBytes());
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        return Http.send(Http.req(port, "/hr/employees/" + employee + "/documents", token).header("Content-Type", "multipart/form-data; boundary=" + boundary)
            .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray())));
    }

    HttpResponse<byte[]> download(String token, String employee, String id) {
        try {
            return Http.CLIENT.send(Http.req(port, "/hr/employees/" + employee + "/documents/" + id, token).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException | InterruptedException e) {
            throw new IllegalStateException(e);
        }
    }

    static JsonNode json(HttpResponse<String> r) {
        try {
            return JSON.readTree(r.body());
        } catch (IOException e) {
            throw new IllegalStateException(r.body(), e);
        }
    }

    HttpResponse<String> uploadPdf(String token, String employee) {
        return upload(token, employee, Part.text("title", "Employment contract"), Part.file("document", "..\\..\\Contrato 2026.pdf", "application/pdf", PDF));
    }

    // ------------------------------------------------------------------ the scenario
    @Test
    void theEmployeeDocumentFlow() throws IOException {
        // 1-7: an authenticated HR user uploads a PDF; the response carries metadata and an opaque identifier
        HttpResponse<String> up = uploadPdf(hr(), "42");
        assertThat(up.statusCode()).as(up.body()).isEqualTo(201);
        JsonNode file = json(up);
        String id = file.get("id").asText();
        assertThat(id).matches("^f_[A-Za-z0-9_-]{22}$");
        assertThat(file.get("filename").asText()).as("sanitized: no directories").isEqualTo("Contrato 2026.pdf");
        assertThat(file.get("contentType").asText()).isEqualTo("application/pdf");
        assertThat(file.get("size").asLong()).isEqualTo(PDF.length);
        assertThat(file.get("ownerRef").asText()).isEqualTo("employee:42");
        assertThat(file.get("checksumSha256").asText()).hasSize(64);
        assertThat(up.body()).as("no key, provider, bucket or path in a public response").doesNotContain("\"key\"").doesNotContain("provider").doesNotContain("pso-it-storage").doesNotContain("employees/42/documents/f_");

        // the file is on disk under a generated key (not the client's name), inside the configured root only
        try (Stream<Path> s = Files.walk(ROOT.resolve("data"))) {
            List<String> names = s.filter(Files::isRegularFile).map(p -> ROOT.resolve("data").relativize(p).toString().replace('\\', '/')).toList();
            assertThat(names).contains("employees/42/documents/" + id);
            assertThat(names).noneMatch(n -> n.contains("Contrato") || n.contains(".."));
        }

        // 8: an authorized user downloads it, safely
        HttpResponse<byte[]> dl = download(employee("42"), "42", id);
        assertThat(dl.statusCode()).isEqualTo(200);
        assertThat(dl.body()).isEqualTo(PDF);
        assertThat(dl.headers().firstValue("Content-Type")).hasValue("application/pdf");
        assertThat(dl.headers().firstValue("Content-Disposition").orElse("")).startsWith("attachment").contains("Contrato 2026.pdf");
        assertThat(dl.headers().firstValue("X-Content-Type-Options")).hasValue("nosniff");
        assertThat(dl.headers().firstValue("Content-Security-Policy").orElse("")).contains("sandbox");
        assertThat(dl.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        assertThat(download(hr(), "42", id).statusCode()).as("HR reads any document").isEqualTo(200);

        // 9: an unauthorized user receives a denial (valid token, valid scope, valid id: the BUSINESS rule says no)
        HttpResponse<byte[]> denied = download(readerWithoutBusinessRights(), "42", id);
        assertThat(denied.statusCode()).isEqualTo(403);
        assertThat(denied.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        assertThat(new String(denied.body(), StandardCharsets.UTF_8)).contains("PSO_AUTH_FORBIDDEN").doesNotContain("Contrato").doesNotContain("employee:42").doesNotContain("hr-1").doesNotContain("%PDF");
        assertThat(download(employee("43"), "42", id).statusCode()).as("another employee").isEqualTo(403);
        assertThat(download(employee("43"), "43", id).statusCode()).as("the id presented under someone else's path").isEqualTo(403);
        assertThat(download(null, "42", id).statusCode()).as("no token").isEqualTo(401);

        // 10: the document can be moved and deleted through authorized operations only
        var archive = Http.send(Http.req(port, "/hr/employees/42/documents/" + id + "/archive", employee("42")).POST(HttpRequest.BodyPublishers.noBody()));
        assertThat(archive.statusCode()).as("an employee may not move documents (scope missing)").isEqualTo(403);
        var archiveByOther = Http.send(Http.req(port, "/hr/employees/42/documents/" + id + "/archive", JWT.token("clerk", List.of("documents:write"), List.of())).POST(HttpRequest.BodyPublishers.noBody()));
        assertThat(archiveByOther.statusCode()).as("scope without the business role").isEqualTo(403);
        var moved = Http.send(Http.req(port, "/hr/employees/42/documents/" + id + "/archive", hr()).POST(HttpRequest.BodyPublishers.noBody()));
        assertThat(moved.statusCode()).as(moved.body()).isEqualTo(200);
        assertThat(json(moved).get("id").asText()).as("the identifier does not change").isEqualTo(id);
        try (Stream<Path> s = Files.walk(ROOT.resolve("data"))) {
            List<String> names = s.filter(Files::isRegularFile).map(p -> ROOT.resolve("data").relativize(p).toString().replace('\\', '/')).toList();
            assertThat(names).contains("archive/employees/42/" + id).doesNotContain("employees/42/documents/" + id);
        }
        assertThat(download(employee("42"), "42", id).body()).as("still downloadable after the move").isEqualTo(PDF);

        var listed = Http.send(Http.req(port, "/hr/employees/42/documents", hr()).GET());
        assertThat(json(listed).get("items")).hasSize(1);
        assertThat(Http.send(Http.req(port, "/hr/employees/42/documents", readerWithoutBusinessRights()).GET()).body()).contains("\"items\":[]");

        assertThat(Http.send(Http.req(port, "/hr/employees/42/documents/" + id, employee("42")).DELETE()).statusCode()).as("scope missing").isEqualTo(403);
        assertThat(Http.send(Http.req(port, "/hr/employees/42/documents/" + id, hr()).DELETE()).statusCode()).isEqualTo(204);
        assertThat(download(hr(), "42", id).statusCode()).isEqualTo(404);
        try (Stream<Path> s = Files.walk(ROOT.resolve("data"))) {
            assertThat(s.filter(Files::isRegularFile).map(p -> p.getFileName().toString())).noneMatch(n -> n.equals(id) || n.equals(id + ".json"));
        }

        // every step left an audit trail with identifiers only
        List<StorageAuditEvent> events = new ArrayList<>(audit.events());
        assertThat(events).extracting(StorageAuditEvent::outcome).contains("ALLOWED", "DENIED");
        assertThat(events).filteredOn(e -> e.outcome().equals("DENIED")).allSatisfy(e -> assertThat(e.reason()).isEqualTo("policy"));
        assertThat(events.toString()).doesNotContain("Contrato").doesNotContain(ROOT.toString());
    }

    @Test
    void uploadsAreValidatedByTheServiceItself() {
        // wrong declared type
        HttpResponse<String> r = upload(hr(), "42", Part.text("title", "t"), Part.file("document", "a.pdf", "image/png", PDF));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(r.body()).as("pdf bytes labelled image/png").contains("PSO_VALIDATION_FAILED").contains("does not match its declared type");
        byte[] png = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4};
        r = upload(hr(), "42", Part.text("title", "t"), Part.file("document", "a.pdf", "image/png", png));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(r.body()).as("a real png is not what this endpoint accepts").contains("not accepted");
        // pdf label, executable content
        r = upload(hr(), "42", Part.text("title", "t"), Part.file("document", "a.pdf", "application/pdf", "MZ\u0090\u0000not a pdf at all".getBytes(StandardCharsets.ISO_8859_1)));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(r.body()).contains("does not match its declared type");
        // wrong extension
        r = upload(hr(), "42", Part.text("title", "t"), Part.file("document", "a.exe", "application/pdf", PDF));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(r.body()).contains("extensions");
        // over the per-call limit (1 MB) but under the container's (2 MB): the framework's own check answers 413
        byte[] big = new byte[1_200_000];
        System.arraycopy(PDF, 0, big, 0, 20);
        r = upload(hr(), "42", Part.text("title", "t"), Part.file("document", "a.pdf", "application/pdf", big));
        assertThat(r.statusCode()).isEqualTo(413);
        assertThat(r.body()).contains("PSO_FILE_TOO_LARGE");
        // way over the container limit
        byte[] huge = new byte[4_000_000];
        r = upload(hr(), "42", Part.text("title", "t"), Part.file("document", "a.pdf", "application/pdf", huge));
        assertThat(r.statusCode()).isEqualTo(413);
        // missing file part
        r = upload(hr(), "42", Part.text("title", "t"));
        assertThat(r.statusCode()).isEqualTo(400);
        // nothing from the refused uploads was kept
        try (Stream<Path> s = Files.walk(ROOT.resolve("data"))) {
            assertThat(s.filter(Files::isRegularFile).filter(p -> !p.toString().contains(".pso-tmp")).map(p -> p.getFileName().toString())).as("only records and files of accepted uploads exist")
                .allSatisfy(n -> assertThat(n).matches("^f_[A-Za-z0-9_-]{22}(\\.json)?$"));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void authenticationAndScopeComeBeforeAnythingIsRead() {
        assertThat(uploadPdf(null, "42").statusCode()).isEqualTo(401);
        assertThat(uploadPdf(employee("42"), "42").statusCode()).as("documents:read is not documents:write").isEqualTo(403);
        assertThat(uploadPdf(JWT.token("clerk", List.of("documents:write"), List.of()), "42").statusCode()).as("scope without the HR role: the business policy denies the store").isEqualTo(403);
    }

    @Test
    void htmlIsNeverServedInlineOrWithItsOwnType() throws IOException {
        // HR stores an HTML file through a policy that allows it (a per-call policy cannot widen the service's default; here the endpoint's policy only allows PDF)
        // so verify the download helper directly with an active type through the service API
        var storage = ctx.getBean(com.pso.spring.storage.PsoStorageService.class);
        var caller = new com.pso.spring.storage.StorageAccess.Caller("hr-1", java.util.Set.of("ROLE_HR"));
        byte[] html = "<html><script>alert(1)</script></html>".getBytes(StandardCharsets.UTF_8);
        var stored = storage.store(caller, com.pso.spring.storage.StorageRequest.builder(new java.io.ByteArrayInputStream(html)).filename("x.html").contentType("text/html").ownerRef("employee:99").build());
        try (var content = storage.open(caller, stored.id())) {
            var response = com.pso.spring.storage.web.FileDownloads.response(content, List.of("image/png", "text/html"));
            assertThat(response.getHeaders().getContentType().toString()).isEqualTo("application/octet-stream");
            assertThat(response.getHeaders().getFirst("Content-Disposition")).startsWith("attachment");
            assertThat(response.getHeaders().getFirst("X-Content-Type-Options")).isEqualTo("nosniff");
        }
        storage.delete(caller, stored.id());
    }

    @Autowired
    org.springframework.context.ApplicationContext ctx;
}
