---
title: File uploads and downloads
description: Receive multipart uploads in the orchestrator, bind them to a DTO with @FileField, validate them while they stream, forward them to a Spring service and stream downloads back.
order: 9
status: stable
keywords: [upload, download, multipart, FileField, FilesField, PsoUploadedFile, forwardUpload, forwardDownload, file, mime, signature, MAX_UPLOAD_BYTES, make:dto, storage]
related: [orchestrator/dto-validation, orchestrator/upstream-clients, spring/storage, security/attack-prevention, reference/error-standard]
---
## What it is

The orchestrator receives `multipart/form-data`, binds files and ordinary fields to a `@Dto` class, checks them, and forwards the validated files to the Spring service that owns the business rules and the storage. You never parse a multipart body in a controller and you never see a physical path.

| Step | Where | Who |
|---|---|---|
| authenticate, authorize (scopes), rate limit | before the body is read | orchestrator |
| parse, bound, spool to private temporary files, validate | `@Body(Dto)` | orchestrator |
| rebuild a clean multipart request and stream it | `Upstream.forwardUpload` | orchestrator |
| business authorization, storage, metadata | the Spring service ([Storage](/spring/storage)) | the service |

## 1. The upload DTO

```typescript
import { Dto, FileField, FilesField, MaxLength, PsoUploadedFile, Required, StringField } from "@pso/http";

@Dto()
export class UploadDocumentDto {
  @FileField({ required: true, maxSize: "10MB", mimeTypes: ["application/pdf"], extensions: [".pdf"] })
  document!: PsoUploadedFile;

  @FilesField({ required: false, maxFiles: 3, maxSize: "2MB", mimeTypes: ["image/png", "image/jpeg"] })
  attachments?: PsoUploadedFile[];

  @Required() @StringField() @MaxLength(80)
  title!: string;
}
```

| Option | Default | Meaning |
|---|---|---|
| `required` | `true` | `false` makes the file optional |
| `maxSize` | `10MB` | per file, enforced **while the body streams** (`10MB` = 10 * 1024 * 1024 bytes) |
| `mimeTypes` | any | exact (`application/pdf`) or family (`image/*`); verified against the file signature |
| `extensions` | any | extensions of the sanitized filename, e.g. `[".pdf"]` |
| `allowEmpty` | `false` | accept a zero-byte file |
| `unverified` | `false` | trust the declared type for a listed type the framework cannot verify |
| `maxFiles` / `minFiles` (`@FilesField`) | `10` (max 100) / `1` | files in the field |

The content types the framework can verify by signature are `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/gzip`, `application/json`, `text/plain`, `text/csv`, `text/markdown` and the zip family (`application/zip`, OOXML and OpenDocument, EPUB). Listing any other type is a **start-up error** unless you set `unverified: true`, so trusting the client is always a visible decision. A zip-family signature cannot distinguish a `.docx` from another zip: the check proves "a zip container", not "a Word document".

A `PsoUploadedFile` has `field`, `filename` (sanitized), `contentType` (declared), `detectedType`, `size`, `sha256`, `stream()` and `buffer(maxBytes)`. The temporary path is not a property and is never serialized.

Files can only be declared at the top level of a DTO. Unknown form fields (and files in undeclared fields) follow the usual `@Dto({ unknown })` policy: rejected by default, their content is discarded and never written.

## 2. The routes

```typescript
@Controller()
@RestController("/employees")
export class DocumentsController {
  constructor(private readonly upstream: Upstream) {}

  @Post("/:id/documents")
  async upload(@Param("id") id: string, @Body(UploadDocumentDto) dto: UploadDocumentDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forwardUpload(req, res, "hr-service", dto, { path: `/employees/${id}/documents` });
  }

  @Get("/:id/documents/:fileId")
  async download(@Param("id") id: string, @Param("fileId") fileId: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forwardDownload(req, res, "hr-service", { path: `/employees/${id}/documents/${fileId}`, maxResponseBytes: 50_000_000 });
  }
}
```

Declare both in `ROUTES.pso.ts` with `security: { guard: "jwt", scopes: [...] }` and `metadata: { service: "hr-service" }` like any forwarded route. The generators write all of this:

```bash
pso make:dto documents upload-document --service gw \
  --fields "document:file:mime=application/pdf:size=10MB:ext=.pdf,title:string:max=80"
pso make:route documents upload --method POST --path /:id/documents --scopes documents:write \
  --upstream hr-service --dto upload-document --service gw
pso make:route documents download --method GET --path /:id/documents/:fileId --scopes documents:read \
  --upstream hr-service --download --max-download 50MB --service gw
```

`make:dto` refuses a file field without `mime=` (it never generates a field that accepts any file) and refuses types it cannot verify. `make:route` with a DTO that has file fields requires `--upstream`: the orchestrator forwards, the service stores. The Spring side is `pso make:files` ([Storage](/spring/storage)).

## 3. Run it and see what happens

```bash
curl -i -X POST http://127.0.0.1:3000/employees/42/documents \
  -H "Authorization: Bearer $TOKEN" -H "X-Correlation-ID: corr-upload-0001" \
  -F title="Employment contract" -F "document=@contract.pdf;type=application/pdf"
```

The service answers with the metadata and an opaque identifier; the orchestrator relays that response unchanged (status and body come from the service).

```http evidence="expected"
HTTP/1.1 201 Created
content-type: application/json
x-correlation-id: corr-upload-0001

{"id":"f_FOnGV-Jgz67FK_f5LA9fnA","filename":"contract.pdf","contentType":"application/pdf","size":4216,"ownerRef":"employee:42", "checksumSha256":"f719...", "context":{"title":"Employment contract"}}
```

The identifier, size and checksum vary per run. Both of the following are asserted by tests that run the real orchestrator in front of the real Spring service (`storage-e2e.test.ts`): the file arrives byte for byte with its sanitized name, and the correlation id survives the whole chain.

## 4. How it behaves

- **Order.** Authentication, scope authorization, rate limits and the concurrency check happen **before** a byte of the body is read. An anonymous caller cannot make the orchestrator write anything to disk.
- **Streaming and backpressure.** The body is consumed chunk by chunk; the next chunk is not read until the previous one reached the file system. Memory does not grow with the file (a test streams 400 MB and asserts the retained memory plateaus).
- **Limits during streaming.** A lying `Content-Length` does not help: bytes are counted as they arrive. The budget of a route comes from its DTO (every `maxSize * maxFiles` plus the ordinary fields), never above `MAX_UPLOAD_BYTES`; the ordinary fields share `MAX_BODY_BYTES`; `MAX_MULTIPART_PARTS` bounds the parts; `MAX_CONCURRENT_UPLOADS` bounds simultaneous uploads (`503` + `Retry-After`).
- **Private temporary files.** One `0700` directory per request, files named with random bytes (never the client\'s name), removed when the response ends: on success, on every error and when the client disconnects.
- **A fresh request to the service.** `forwardUpload` re-encodes only the validated, declared fields and files. The client\'s raw body, boundary, `Content-Type` and `x-pso-*` headers are never relayed; the bearer travels only as your [upstream policy](/security/service-identity) allows, so the service authenticates the caller itself.
- **Compatibility.** `@Body()` and `@Body(Dto)` without file fields behave as before; a DTO with file fields answers `415` to a JSON body.

## 5. Errors

| Situation | Response |
|---|---|
| not `multipart/form-data` on an upload route | `415 PSO_HTTP_UNSUPPORTED_MEDIA_TYPE` |
| missing boundary, truncated or malformed parts, invalid UTF-8 in a field | `400 PSO_HTTP_MALFORMED_MULTIPART` |
| a field or file rule is not met (required, type, signature, extension, count, unexpected field) | `400 PSO_VALIDATION_FAILED` with `errors[]` naming the field, never the content |
| a file over `maxSize` | `413 PSO_FILE_TOO_LARGE` |
| the request over the route budget, `MAX_UPLOAD_BYTES` or `MAX_MULTIPART_PARTS` | `413 PSO_HTTP_PAYLOAD_TOO_LARGE` |
| too many uploads at once | `503 PSO_SERVER_BUSY` + `Retry-After` |
| the service is down | `503 PSO_UPSTREAM_UNAVAILABLE`; temporary files are still removed |

The client closing the connection mid-upload cannot be answered; the partial files are removed and the request is counted with status `499` in the metrics.

## 6. Downloads

`forwardDownload` streams the service\'s response with backpressure. On a `2xx` it adds `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store` and `Content-Disposition: attachment` when the service sent no disposition. Error responses are relayed untouched. The size cap is per call (`maxResponseBytes`); a plain `forward()` keeps `MAX_UPSTREAM_RESPONSE_BYTES`. Authorization of **who may read which file** belongs to the service: possessing an id grants nothing.

## Production considerations

- Raise `REQUEST_TIMEOUT_MS` (default 30 s) if your largest legitimate upload needs longer on your slowest network.
- Keep `maxSize` and the Spring `pso.storage.upload.max-size` and `pso.limits.multipart.max-file-size` consistent: the smallest one wins and the others never see the file.
- Put the system temporary directory (`TMPDIR`) on a volume with room for `MAX_CONCURRENT_UPLOADS * MAX_UPLOAD_BYTES`.
- Malware scanning is not performed by the orchestrator; use the `ContentScanner` hook in the service.

## Common mistakes

| Mistake | What happens | Fix |
|---|---|---|
| `@Body() dto: UploadDocumentDto` without the class in the decorator | no file binding | `@Body(UploadDocumentDto)` |
| `document: File` as the property type | the global DOM `File` is not the value | `PsoUploadedFile` |
| listing `application/msword` in `mimeTypes` | start-up error: no signature check | list verifiable types or set `unverified: true` knowingly |
| using `forward()` for an upload route that has a DTO | the body was already consumed and validated; the client\'s bytes are replayed unvalidated framing | `forwardUpload` |
| a `maxSize` above `MAX_UPLOAD_BYTES` | files are refused by the route budget first | raise `MAX_UPLOAD_BYTES` deliberately |

## Next steps

- [Storage in Spring Boot services](/spring/storage): where the files go and who may read them.
- [Validate request bodies with DTOs](/orchestrator/dto-validation) and [Upstream clients](/orchestrator/upstream-clients).
