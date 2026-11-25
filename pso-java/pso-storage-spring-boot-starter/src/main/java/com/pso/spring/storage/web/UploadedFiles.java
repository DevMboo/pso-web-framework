package com.pso.spring.storage.web;

import com.pso.spring.storage.StorageException;
import com.pso.spring.storage.StorageRequest;
import java.io.IOException;
import org.springframework.web.multipart.MultipartFile;

/** Adapts a Spring {@link MultipartFile} (spooled to disk by the container, never held whole in memory) to a {@link StorageRequest}. */
public final class UploadedFiles {

    private UploadedFiles() {
    }

    /** A builder pre-filled from the file: stream, size, declared content type and (to be sanitized) client filename. Add owner, namespace and context. */
    public static StorageRequest.Builder request(MultipartFile file) {
        try {
            return StorageRequest.builder(file.getInputStream()).filename(file.getOriginalFilename()).contentType(file.getContentType()).contentLength(file.getSize());
        } catch (IOException e) {
            throw new StorageException.Unavailable("cannot read the uploaded file", e);
        }
    }
}
