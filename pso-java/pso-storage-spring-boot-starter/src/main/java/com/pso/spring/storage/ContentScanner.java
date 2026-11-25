package com.pso.spring.storage;

import java.io.IOException;
import java.io.InputStream;

/**
 * Integration point for malware scanning. The framework ships NO scanning engine and never claims protection it does not have: with no
 * ContentScanner bean, uploads are not scanned (and {@code pso.storage.scan.required=true} refuses to start). Implement this interface with
 * your engine (ClamAV, a cloud scanning API...) and register it as a bean.
 *
 * <p>The scan runs after the content was written under its private, unguessable key and before the file becomes addressable by id; an
 * infected or unscannable file is deleted and the upload fails.
 */
@FunctionalInterface
public interface ContentScanner {

    /** The content to inspect. {@code content} is a fresh stream the scanner must close. */
    record Target(String filename, String contentType, long size, java.util.function.Supplier<InputStream> content) {
        public InputStream open() throws IOException {
            return content.get();
        }
    }

    sealed interface Verdict permits Verdict.Clean, Verdict.Infected, Verdict.Failed {
        record Clean() implements Verdict {
        }

        /** {@code signature} is for the audit log only, never shown to the client. */
        record Infected(String signature) implements Verdict {
        }

        /** The engine could not decide: the upload is refused (fail closed). */
        record Failed(String reason) implements Verdict {
        }
    }

    Verdict scan(Target target);
}
