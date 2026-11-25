---
title: Storage
description: PSO Storage for Spring Boot services - one API over the local filesystem, Amazon S3 and Azure Blob Storage, with opaque identifiers, ownership, upload validation, safe downloads and audit events.
order: 8
status: stable
keywords: [storage, file, upload, download, s3, azure blob, local filesystem, PsoStorageService, StorageAccess, ContentScanner, signed url, pso.storage, storage:enable, make:files, multipart]
related: [orchestrator/file-uploads, spring/configuration, spring/limits, security/attack-prevention, reference/error-standard, spring/overview]
---
## What it is

`pso-storage-spring-boot-starter` gives a service one API to store, read, copy, move, delete, list and sign files, whatever backs it:

| Provider | `pso.storage.provider` | For | Verified |
|---|---|---|---|
| Local filesystem | `local` | development, tests, self-hosted | real filesystem tests (symbolic-link tests need a platform that can create links: skipped on Windows without developer mode) |
| Amazon S3 | `s3` | cloud | adapter tests against a **mocked** S3 client; not run against Amazon S3 or an emulator |
| Azure Blob Storage | `azure` | cloud | adapter tests against **mocked** Azure clients; not run against Azure or Azurite |

The framework owns the infrastructure (streaming, validation, keys, providers, safe downloads, audit). **Your service owns business authorization.** Storage is optional: with no `pso.storage.provider`, nothing is configured and no provider SDK is loaded.

## 1. Enable it

```bash
pso storage:enable local --service hr-service                     # development, self-hosted
pso storage:enable s3 --service hr-service --bucket acme-hr-documents --region eu-west-1
pso storage:enable azure --service hr-service                     # endpoint and container from the environment
pso storage:validate --service hr-service
```

It adds `pso-storage-spring-boot-starter` (and the S3 or Azure SDK; versions come from `pso-bom`), writes the `pso.storage` block, enables multipart, and gives the **local** and **test** profiles a local provider so development and tests never need a cloud account. It writes no secrets: S3 uses the AWS default credential chain, Azure uses `DefaultAzureCredential` (managed identity). Running it again changes nothing.

```yaml
pso:
  storage:
    provider: s3
    s3:
      bucket: acme-hr-documents
      region: eu-west-1
      prefix: hr/
    upload:
      max-size: 5MB          # keep <= pso.limits.multipart.max-file-size
      allowed-content-types: [application/pdf]
  limits:
    multipart: { enabled: true, max-file-size: 5MB, max-request-size: 10MB }
```

| Key | Default | Notes |
|---|---|---|
| `provider` | unset | `local`, `s3`, `azure` |
| `local.root` | required for `local` | created with owner-only permissions; keep it outside any served directory |
| `s3.bucket` / `region` / `prefix` / `endpoint` / `path-style-access` | `bucket` required | `endpoint` and path style for MinIO or LocalStack; objects are always private |
| `azure.endpoint` / `container` / `prefix` / `copy-timeout` | `container` required | `endpoint` with a managed identity |
| `azure.connection-string` | none | Azurite and local work only; refused in `prod` and `staging` |
| `upload.max-size` | `10MB` | enforced while streaming |
| `upload.allowed-content-types` / `allowed-extensions` | any | known formats are verified by signature regardless |
| `upload.allow-unverified-types` | `false` | trust the declared type for types without a signature check |
| `download.inline-content-types` | png, jpeg, gif, webp | everything else is an attachment |
| `signed-url.enabled` / `default-ttl` / `max-ttl` | `false` / `1m` / `5m` | S3 and Azure only |
| `scan.required` | `false` | `true` refuses to start without a `ContentScanner` bean |
| `metadata.store` | `provider` | `provider` or `memory` (tests); a `FileMetadataStore` bean replaces both |

## 2. Use it

```bash
pso make:files documents --service hr-service --mime application/pdf --ext .pdf --max-size 5MB
```

writes a controller (upload, download, metadata, list, move, delete, each with a scope check) and a test that exercises real multipart through MockMvc. The part that matters:

```java
@PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
@PreAuthorize("hasAuthority('SCOPE_documents:write')")
public ResponseEntity<StoredFile.FileView> upload(@RequestParam("document") MultipartFile file) {
    StorageAccess.Caller caller = storage.currentCaller();
    StoredFile stored = storage.store(caller, UploadedFiles.request(file)
        .ownerRef(caller.subject()).namespace("files/documents").policy(POLICY).build());
    return ResponseEntity.status(201).body(stored.view());
}

@GetMapping("/{id}")
@PreAuthorize("hasAuthority('SCOPE_documents:read')")
public ResponseEntity<InputStreamResource> download(@PathVariable String id) {
    PsoStorageService.FileContent content = storage.open(storage.currentCaller(), id);
    return FileDownloads.response(content, props.getStorage().getDownload().getInlineContentTypes());
}
```

`PsoStorageService` operations (each takes the caller and asks the access policy first):

| Method | Result |
|---|---|
| `store(caller, StorageRequest)` | `StoredFile` with an opaque id (`f_...`), sanitized filename, size, SHA-256, owner, context |
| `open(caller, id)` | `FileContent` (close it) streaming from the provider |
| `metadata(caller, id)`, `list(caller, ListQuery)` | records; `list` is paginated (cursor, at most 200, may return fewer than `limit` when records are hidden from the caller) |
| `copy(caller, id, namespace, ownerRef)`, `move(caller, id, namespace)`, `delete(caller, id)` | copy gives a new id; move keeps the id and changes the key |
| `signedUrl(caller, id, ttl)` | a short-lived provider URL, only when enabled and supported (local returns empty: no URL is invented) |

`StoredFile.view()` is what an API may return; `key` and `provider` stay internal. The Java types: `StorageProvider` (SPI), `FileMetadataStore`, `StorageAccess.Policy`, `StorageAccess.CallerResolver`, `UploadPolicy`, `ContentScanner`, `StorageAuditEvent`.

## 3. Authorization is yours

The default policy is strict: an authenticated caller may store, and may read, move, copy, delete or sign only files they uploaded or that carry their own subject as `ownerRef`. Replace it with a bean:

```java
@Bean
StorageAccess.Policy employeeDocumentsPolicy() {
    return (op, caller, file) -> {
        if (caller == null || caller.subject() == null) return false;
        if (caller.has("ROLE_HR")) return true;                                   // HR manages everything
        return op == StorageAccess.Operation.READ && file != null
            && ("employee:" + caller.subject()).equals(file.ownerRef());           // an employee reads their own
    };
}
```

A policy that throws denies. A denial is `403`; the caller\'s `uploadedBy` and the business owner (`ownerRef`) are separate on purpose: storage identity is not ownership. Check the id belongs to the resource in the URL (`/employees/42/documents/{id}`) as the example in `StorageEndToEndTests` does.

The caller comes from the Spring Security context (the PSO JWT subject and authorities); without Spring Security provide a `StorageAccess.CallerResolver` bean or pass a `Caller` explicitly.

## 4. Security controls

| Control | How |
|---|---|
| size | counted while streaming; a lying length is irrelevant; nothing is stored when exceeded; the per-call `UploadPolicy` can only narrow the limit |
| type | declared type checked against the allow-list **and** the file signature; a PDF declared as text, an executable named `.pdf` and a zip posing as a PDF are refused |
| names | `SafeFileNames.sanitize`: no directories, control or bidirectional characters, no reserved names; never part of a key |
| keys | generated: `<validated namespace>/<random id>`; `..`, absolute paths, empty or dot segments and the reserved `_pso` namespace are refused at the service and again by every provider |
| local provider | each path segment must be a plain file or directory exactly where the key says (symbolic links and junctions refused), temporary file in the same filesystem then rename without replacing, `fsync`, owner-only permissions, stale temp sweep at start-up, no absolute path in any response |
| private by default | no ACLs, no public buckets or containers; S3 `If-None-Match: *` and Azure `If-None-Match: *` refuse overwrites |
| downloads | `FileDownloads` sends `application/octet-stream` for HTML, SVG, XML and script types, `attachment` unless the type is on the inline allow-list, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store` |
| signed URLs | opt in, authorized per call, capped TTL (default 1 minute, max 5), Azure user-delegation SAS with a managed identity; treat the URL as a credential |
| errors | `StorageProblemAdvice` answers with fixed catalog texts; provider messages (buckets, accounts, paths) stay in the server log |
| audit | a `StorageAuditEvent` for every operation, allowed or denied: operation, file id, subject, outcome, reason; never content, names or paths. Listen with `@EventListener` |
| malware | **no scanning engine is included.** Register a `ContentScanner` bean to scan after the write and before the file becomes addressable (infected or undecidable uploads are deleted, fail closed); `scan.required: true` refuses to start without one |
| rate limiting | uploads pass through the same per-address, per-principal and per-route limits as every request ([limits](/spring/limits)) |

## 5. What the providers guarantee

- `put`, `copy`, `move` never overwrite; a failed `put` leaves no visible object; `delete` is idempotent.
- S3 and Azure have no cross-object transactions. `move` is copy, save the record, then delete the old object: a crash leaves an orphaned object, never a record pointing at nothing. S3 copy is limited to 5 GB per object; Azure copy is asynchronous and the adapter waits for it (`copy-timeout`), deleting a failed destination.
- Without a known content length, S3 and Azure uploads spool to a temporary file first (both need the length), bounded by the upload limit. `MultipartFile` uploads always have a length.
- Metadata defaults to a small JSON record next to each file (`_pso/files/<id>.json`): no shared database. Listing through it reads one record per file: use a `FileMetadataStore` backed by the service\'s own database for large collections.
- A file whose record was never saved (crash between the two writes) is an unreachable orphan object; there is no automatic sweeper yet.

## 6. Failures

| Symptom | Cause | Fix |
|---|---|---|
| `415 PSO_HTTP_MULTIPART_DISABLED` | multipart is off | `pso.limits.multipart.enabled: true` (`storage:enable` does it) |
| `413` for a file below `upload.max-size` | `pso.limits.multipart.max-file-size` is smaller | raise both consistently (`storage:validate` reports it as `STO010`) |
| start-up error naming `pso.storage.s3.bucket` (or another key) | required value missing | set it; the message names the property |
| start-up error "needs the AWS SDK" / "Azure SDK" | provider selected without its dependency | add it (`storage:enable` does) |
| `503 PSO_STORAGE_UNAVAILABLE` | the backend failed (credentials, network, disk) | check the server log and `/actuator/health` (`psoStorage` component) |
| `403` everywhere | the default owner-only policy | declare your `StorageAccess.Policy` bean |
| `400` "content does not match its declared type" | the bytes are not what the client claimed | working as designed |

## Common mistakes

| Mistake | Fix |
|---|---|
| returning `StoredFile` from a controller | return `stored.view()`: `key` and `provider` are internal |
| letting the client choose `ownerRef` | derive it from the authenticated caller or the resource path |
| using a client filename in a path | never: keys are generated |
| enabling `signed-url` to avoid writing a download route | prefer the authenticated route; signed URLs are bearer credentials |
| assuming uploads are scanned | register a `ContentScanner`; none is included |
| using `local` in production behind several replicas | use `s3` or `azure`, or a shared persistent volume on purpose (`STO005`) |

## Next steps

- [File uploads and downloads in the orchestrator](/orchestrator/file-uploads)
- [Spring configuration reference](/spring/configuration) and [request limits](/spring/limits)
