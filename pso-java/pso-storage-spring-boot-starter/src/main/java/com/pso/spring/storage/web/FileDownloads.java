package com.pso.spring.storage.web;

import com.pso.spring.storage.ActiveContent;
import com.pso.spring.storage.FileSignatures;
import com.pso.spring.storage.PsoStorageService.FileContent;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/**
 * Builds the safe response for an authenticated download. Rules, not options:
 * <ul>
 *   <li>the stored content type is sent only when it is a well-formed, non-active type; HTML, SVG, XML and script types are sent as
 *       {@code application/octet-stream};</li>
 *   <li>{@code Content-Disposition} is {@code attachment} unless the type is in the configured inline allow-list (images by default)
 *       and not active;</li>
 *   <li>{@code X-Content-Type-Options: nosniff}, {@code Content-Security-Policy: sandbox; default-src 'none'} and
 *       {@code Cache-Control: private, no-store} are always set, so nothing the file contains runs in the application's origin.</li>
 * </ul>
 * The stream is closed by Spring after it is written (or when the client goes away).
 */
public final class FileDownloads {

    private FileDownloads() {
    }

    public static ResponseEntity<InputStreamResource> response(FileContent content, Collection<String> inlineTypes) {
        var file = content.file();
        String type = ActiveContent.safeType(file.contentType());
        boolean inline = !ActiveContent.isActive(file.contentType()) && inlineTypes.stream().anyMatch(t -> t.equalsIgnoreCase(FileSignatures.normalize(type)));
        boolean ascii = file.filename().chars().allMatch(c -> c >= 0x20 && c < 0x7f);
        ContentDisposition.Builder builder = inline ? ContentDisposition.inline() : ContentDisposition.attachment();
        // plain ASCII names stay plain; others get the RFC 5987/6266 filename* form (Spring adds an encoded fallback)
        ContentDisposition disposition = (ascii ? builder.filename(file.filename()) : builder.filename(file.filename(), StandardCharsets.UTF_8)).build();
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.parseMediaType(type));
        h.setContentLength(file.size());
        h.set(HttpHeaders.CONTENT_DISPOSITION, disposition.toString());
        h.set("X-Content-Type-Options", "nosniff");
        h.set("Content-Security-Policy", "sandbox; default-src 'none'");
        h.setCacheControl("private, no-store");
        return ResponseEntity.ok().headers(h).body(new InputStreamResource(content.stream()));
    }
}
