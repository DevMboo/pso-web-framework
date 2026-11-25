package com.pso.spring.storage;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Constraints on an upload, checked by the service (the orchestrator checks the same things earlier; the service never relies on that).
 * The declared content type and the extension are inputs, not proof: known formats are verified against the file signature.
 *
 * @param maxSize        largest accepted size in bytes
 * @param contentTypes   accepted types, exact or {@code type/*}; empty = any
 * @param extensions     accepted lower-case extensions with the dot; empty = any
 * @param allowUnverified trust the declared type of listed types that have no signature check
 */
public record UploadPolicy(long maxSize, Set<String> contentTypes, Set<String> extensions, boolean allowUnverified) {

    public UploadPolicy {
        if (maxSize <= 0) {
            throw new IllegalArgumentException("maxSize must be positive");
        }
        contentTypes = lower(contentTypes);
        extensions = lower(extensions).stream().map(e -> e.startsWith(".") ? e : "." + e).collect(java.util.stream.Collectors.toUnmodifiableSet());
    }

    public static UploadPolicy of(long maxSize) {
        return new UploadPolicy(maxSize, Set.of(), Set.of(), false);
    }

    public UploadPolicy withContentTypes(String... types) {
        return new UploadPolicy(maxSize, Set.of(types), extensions, allowUnverified);
    }

    public UploadPolicy withExtensions(String... exts) {
        return new UploadPolicy(maxSize, contentTypes, Set.of(exts), allowUnverified);
    }

    public UploadPolicy withMaxSize(long bytes) {
        return new UploadPolicy(bytes, contentTypes, extensions, allowUnverified);
    }

    private static Set<String> lower(Set<String> in) {
        return in == null ? Set.of() : in.stream().map(s -> s.trim().toLowerCase(Locale.ROOT)).filter(s -> !s.isEmpty()).collect(java.util.stream.Collectors.toUnmodifiableSet());
    }

    /** Checks name, declared type and the first bytes of the content. Size is enforced separately while streaming. */
    void check(String safeFilename, String declaredType, byte[] head) {
        List<StorageException.Invalid.Problem> problems = new ArrayList<>();
        if (!extensions.isEmpty() && !extensions.contains(SafeFileNames.extension(safeFilename))) {
            problems.add(new StorageException.Invalid.Problem("file", "must have one of the extensions: " + String.join(", ", extensions.stream().sorted().toList())));
        }
        if (!contentTypes.isEmpty() && !FileSignatures.allowed(contentTypes, declaredType)) {
            problems.add(new StorageException.Invalid.Problem("file", "has a content type that is not accepted"));
        }
        if (problems.isEmpty()) {
            boolean known = FileSignatures.hasRule(declaredType);
            if (known && !FileSignatures.verify(declaredType, head)) {
                problems.add(new StorageException.Invalid.Problem("file", "has content that does not match its declared type"));
            } else if (!known && !contentTypes.isEmpty() && !allowUnverified) {
                problems.add(new StorageException.Invalid.Problem("file", "has a content type whose content cannot be verified"));
            } else {
                String real = FileSignatures.detect(head);
                if (real != null && !FileSignatures.compatible(declaredType, real)) {
                    problems.add(new StorageException.Invalid.Problem("file", "has content that does not match its declared type"));
                }
            }
        }
        if (!problems.isEmpty()) {
            throw new StorageException.Invalid(problems);
        }
    }
}
