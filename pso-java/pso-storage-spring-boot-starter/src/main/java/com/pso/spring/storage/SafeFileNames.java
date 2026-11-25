package com.pso.spring.storage;

import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Filename sanitization. The result is safe to display and to offer as a download name; it is never used to build a storage key
 * (keys are generated). No directories, no control or bidirectional-override characters, no characters special to common filesystems,
 * no leading dot, at most 255 bytes, never empty.
 */
public final class SafeFileNames {

    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]");
    private static final Pattern SPECIAL = Pattern.compile("[<>:\"|?*\\\\/]");
    private static final Pattern RESERVED = Pattern.compile("^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$", Pattern.CASE_INSENSITIVE);

    private SafeFileNames() {
    }

    public static String sanitize(String raw) {
        if (raw == null) {
            return "file";
        }
        String n = Normalizer.normalize(raw, Normalizer.Form.NFC);
        n = n.substring(Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\')) + 1);
        n = SPECIAL.matcher(CONTROL.matcher(n).replaceAll("")).replaceAll("_");
        n = n.replaceFirst("^[.\\s]+", "").replaceFirst("[.\\s]+$", "");
        if (n.isEmpty()) {
            return "file";
        }
        if (RESERVED.matcher(n).matches()) {
            n = "_" + n;
        }
        if (n.getBytes(StandardCharsets.UTF_8).length > 255) {
            int dot = n.lastIndexOf('.');
            String ext = dot > 0 && n.length() - dot <= 16 ? n.substring(dot) : "";
            String base = ext.isEmpty() ? n : n.substring(0, dot);
            while (base.getBytes(StandardCharsets.UTF_8).length + ext.getBytes(StandardCharsets.UTF_8).length > 255) {
                base = base.substring(0, base.length() - 1);
            }
            n = base + ext;
        }
        return n;
    }

    /** Lower-case extension with the dot, or "". */
    public static String extension(String filename) {
        int i = filename.lastIndexOf('.');
        return i > 0 ? filename.substring(i).toLowerCase(Locale.ROOT) : "";
    }
}
