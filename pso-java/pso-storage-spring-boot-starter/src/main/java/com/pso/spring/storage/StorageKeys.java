package com.pso.spring.storage;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Storage keys and namespaces. A key is NOT a filesystem path supplied by a user: the framework builds it from a validated namespace
 * and a generated identifier, and every provider validates it again before touching its backend (defence in depth).
 */
public final class StorageKeys {

    public static final int MAX_KEY_LENGTH = 512;
    public static final int MAX_DEPTH = 16;
    /** Reserved first segment of the records the metadata store keeps next to the files. Applications cannot use it as a namespace. */
    public static final String INTERNAL_PREFIX = "_pso";

    private static final Pattern SEGMENT = Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$");
    private static final Pattern NAMESPACE_SEGMENT = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    private StorageKeys() {
    }

    /** Provider-level validation: relative, forward-slash separated, no empty, dot or dot-dot segments, no characters special to any backend. */
    public static String requireValid(String key) {
        if (key == null || key.isEmpty() || key.length() > MAX_KEY_LENGTH) {
            throw new StorageException.Invalid("key", "must be between 1 and " + MAX_KEY_LENGTH + " characters");
        }
        List<String> segments = List.of(key.split("/", -1));
        if (segments.size() > MAX_DEPTH) {
            throw new StorageException.Invalid("key", "is nested too deeply");
        }
        for (String s : segments) {
            if (!SEGMENT.matcher(s).matches() || s.equals(".") || s.equals("..") || s.endsWith(".")) {
                throw new StorageException.Invalid("key", "contains an invalid segment");
            }
        }
        return key;
    }

    /** Service-level validation of an application namespace (a folder-like grouping): up to 8 safe segments, never the reserved prefix. */
    public static String namespace(String namespace) {
        if (namespace == null || namespace.isEmpty()) {
            return "";
        }
        String[] segments = namespace.split("/", -1);
        if (segments.length > 8) {
            throw new StorageException.Invalid("namespace", "is nested too deeply");
        }
        for (String s : segments) {
            if (!NAMESPACE_SEGMENT.matcher(s).matches() || s.equals("..") || s.endsWith(".")) {
                throw new StorageException.Invalid("namespace", "may contain only letters, digits, '.', '_' and '-' in each '/'-separated segment");
            }
        }
        return namespace;
    }

    public static String join(String namespace, String name) {
        return namespace.isEmpty() ? name : namespace + "/" + name;
    }

    public static boolean isInternal(String key) {
        return key.equals(INTERNAL_PREFIX) || key.startsWith(INTERNAL_PREFIX + "/");
    }
}
