package com.pso.it.docs;

import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.storage.PsoStorageService;
import com.pso.spring.storage.StorageAccess;
import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StoredFile;
import com.pso.spring.storage.UploadPolicy;
import com.pso.spring.storage.web.FileDownloads;
import com.pso.spring.storage.web.UploadedFiles;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.multipart.MultipartFile;

/**
 * The fictional employee-documents service of the storage end-to-end test. The framework owns uploads, validation, storage and safe
 * downloads; THIS class owns the business rules: HR staff manage every document, an employee may only read their own.
 */
@SpringBootApplication
public class DocsApp {

    /** Lets the cross-language test (packages/cli/test/storage-e2e.test.ts) run this service as a separate process behind the real orchestrator. */
    public static void main(String[] args) {
        org.springframework.boot.SpringApplication.run(DocsApp.class, args);
    }

    @Bean
    StorageAccess.Policy employeeDocumentsPolicy() {
        return (op, caller, file) -> {
            if (caller == null || caller.subject() == null || caller.subject().isBlank()) {
                return false;
            }
            if (caller.has("ROLE_HR")) {
                return true;
            }
            return op == StorageAccess.Operation.READ && file != null && ("employee:" + caller.subject()).equals(file.ownerRef());
        };
    }

    @RestController
    @RequestMapping("/employees/{employeeId}/documents")
    public static class EmployeeDocumentsController {

        private final PsoStorageService storage;
        private final PsoProperties props;

        EmployeeDocumentsController(PsoStorageService storage, PsoProperties props) {
            this.storage = storage;
            this.props = props;
        }

        @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
        @PreAuthorize("hasAuthority('SCOPE_documents:write')")
        public ResponseEntity<StoredFile.FileView> upload(@PathVariable String employeeId, @RequestParam("document") MultipartFile document,
                                                          @RequestParam("title") String title) {
            StoredFile stored = storage.store(storage.currentCaller(), UploadedFiles.request(document)
                .ownerRef("employee:" + employeeId).namespace("employees/" + employeeId + "/documents").context("title", title)
                .policy(UploadPolicy.of(1_000_000).withContentTypes("application/pdf").withExtensions(".pdf")).build());
            return ResponseEntity.status(201).body(stored.view());
        }

        @GetMapping("/{fileId}")
        @PreAuthorize("hasAuthority('SCOPE_documents:read')")
        public ResponseEntity<InputStreamResource> download(@PathVariable String employeeId, @PathVariable String fileId) throws IOException {
            PsoStorageService.FileContent content = storage.open(storage.currentCaller(), fileId);
            if (!("employee:" + employeeId).equals(content.file().ownerRef())) { // the id must belong to the employee in the path
                content.close();
                throw new StorageException.NotFound("no such file");
            }
            return FileDownloads.response(content, props.getStorage().getDownload().getInlineContentTypes());
        }

        @GetMapping
        @PreAuthorize("hasAuthority('SCOPE_documents:read')")
        public Map<String, Object> list(@PathVariable String employeeId, @RequestParam(required = false) String cursor, @RequestParam(defaultValue = "2") int limit) {
            PsoStorageService.FilePage page = storage.list(storage.currentCaller(), new PsoStorageService.ListQuery("employee:" + employeeId, null, cursor, limit));
            List<StoredFile.FileView> items = page.items().stream().map(StoredFile::view).toList();
            return Map.of("items", items, "nextCursor", page.nextCursor() == null ? "" : page.nextCursor());
        }

        @PostMapping("/{fileId}/archive")
        @PreAuthorize("hasAuthority('SCOPE_documents:write')")
        public StoredFile.FileView archive(@PathVariable String employeeId, @PathVariable String fileId) {
            return storage.move(storage.currentCaller(), fileId, "archive/employees/" + employeeId).view();
        }

        @DeleteMapping("/{fileId}")
        @PreAuthorize("hasAuthority('SCOPE_documents:write')")
        public ResponseEntity<Void> delete(@PathVariable String employeeId, @PathVariable String fileId) {
            storage.delete(storage.currentCaller(), fileId);
            return ResponseEntity.noContent().build();
        }
    }
}
