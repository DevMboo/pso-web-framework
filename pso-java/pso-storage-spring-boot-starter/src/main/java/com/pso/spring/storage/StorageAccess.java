package com.pso.spring.storage;

import java.util.Set;

/**
 * Who is calling, what they want to do, and the policy that decides. The framework owns the infrastructure; the application owns business
 * authorization: replace the default {@link StorageAccessPolicy} bean with rules such as "HR staff may read any employee document".
 */
public final class StorageAccess {

    private StorageAccess() {
    }

    public enum Operation { STORE, READ, MOVE, COPY, DELETE, SIGN }

    /** The authenticated caller. {@code subject} must be non-blank for any operation to be allowed by the default policy. */
    public record Caller(String subject, Set<String> authorities) {
        public Caller {
            authorities = authorities == null ? Set.of() : Set.copyOf(authorities);
        }

        public boolean has(String authority) {
            return authorities.contains(authority);
        }
    }

    /** Decides whether {@code caller} may perform {@code operation}. For STORE, {@code file} describes the prospective file (id and key are null). Throw nothing: return false to deny. */
    @FunctionalInterface
    public interface Policy {
        boolean allows(Operation operation, Caller caller, StoredFile file);
    }

    /**
     * Default policy, deliberately strict: an authenticated caller may store, and may read, move, copy, delete or sign only the files they
     * uploaded or that are owned (ownerRef) by their own subject. Everything else is denied.
     */
    public static final Policy OWNER_ONLY = (operation, caller, file) -> {
        if (caller == null || caller.subject() == null || caller.subject().isBlank()) {
            return false;
        }
        if (operation == Operation.STORE) {
            return true;
        }
        return file != null && (caller.subject().equals(file.uploadedBy()) || caller.subject().equals(file.ownerRef()));
    };

    /** Resolves the caller of the current request (the default implementation reads the Spring Security context when it is on the classpath). */
    @FunctionalInterface
    public interface CallerResolver {
        Caller current();
    }
}
