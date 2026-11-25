package com.pso.spring.storage;

import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/** Content verification by signature for the formats the framework knows. Mirrors the orchestrator's checks (same rules, same families). */
public final class FileSignatures {

    public static final int HEAD_BYTES = 4096;

    private static final Set<String> ZIP_FAMILY = Set.of("application/zip", "application/epub+zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.presentation");
    private static final Map<String, Predicate<byte[]>> RULES = new LinkedHashMap<>();

    static {
        RULES.put("application/pdf", b -> ascii(b, "%PDF-", 0));
        RULES.put("image/png", b -> starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
        RULES.put("image/jpeg", b -> starts(b, 0xff, 0xd8, 0xff));
        RULES.put("image/gif", b -> ascii(b, "GIF87a", 0) || ascii(b, "GIF89a", 0));
        RULES.put("image/webp", b -> ascii(b, "RIFF", 0) && ascii(b, "WEBP", 8));
        RULES.put("application/gzip", b -> starts(b, 0x1f, 0x8b));
        RULES.put("application/json", FileSignatures::looksLikeJson);
        RULES.put("text/plain", FileSignatures::looksLikeText);
        RULES.put("text/csv", FileSignatures::looksLikeText);
        RULES.put("text/markdown", FileSignatures::looksLikeText);
        for (String z : ZIP_FAMILY) {
            RULES.put(z, FileSignatures::isZip);
        }
    }

    private FileSignatures() {
    }

    public static String normalize(String contentType) {
        if (contentType == null) {
            return "";
        }
        int semi = contentType.indexOf(';');
        return (semi >= 0 ? contentType.substring(0, semi) : contentType).trim().toLowerCase(Locale.ROOT);
    }

    public static boolean hasRule(String type) {
        return RULES.containsKey(type);
    }

    public static boolean verify(String type, byte[] head) {
        Predicate<byte[]> rule = RULES.get(type);
        return rule != null && rule.test(head);
    }

    /** The type recognised from a signature, or null (text and JSON have none). */
    public static String detect(byte[] head) {
        for (String t : new String[] {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "application/gzip"}) {
            if (RULES.get(t).test(head)) {
                return t;
            }
        }
        return isZip(head) ? "application/zip" : null;
    }

    public static boolean compatible(String declared, String real) {
        return declared.equals(real) || (real.equals("application/zip") && ZIP_FAMILY.contains(declared));
    }

    public static boolean allowed(Set<String> allowedTypes, String type) {
        for (String a : allowedTypes) {
            if (a.equals(type) || (a.endsWith("/*") && type.startsWith(a.substring(0, a.length() - 1)))) {
                return true;
            }
        }
        return false;
    }

    private static boolean starts(byte[] b, int... sig) {
        if (b.length < sig.length) {
            return false;
        }
        for (int i = 0; i < sig.length; i++) {
            if ((b[i] & 0xff) != sig[i]) {
                return false;
            }
        }
        return true;
    }

    private static boolean ascii(byte[] b, String s, int at) {
        if (b.length < at + s.length()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            if (b[at + i] != (byte) s.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    private static boolean isZip(byte[] b) {
        return starts(b, 0x50, 0x4b, 0x03, 0x04) || starts(b, 0x50, 0x4b, 0x05, 0x06);
    }

    private static boolean looksLikeText(byte[] b) {
        for (byte x : b) {
            int c = x & 0xff;
            if (c == 0 || (c < 32 && c != 9 && c != 10 && c != 12 && c != 13 && c != 27)) {
                return false;
            }
        }
        // a multi-byte character may be cut at the end of the sample
        int len = b.length == HEAD_BYTES ? b.length - 3 : b.length;
        try {
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b, 0, len));
            return true;
        } catch (CharacterCodingException e) {
            return false;
        }
    }

    private static boolean looksLikeJson(byte[] b) {
        String s = new String(b, StandardCharsets.UTF_8);
        if (s.startsWith("﻿")) {
            s = s.substring(1);
        }
        s = s.stripLeading();
        return (s.startsWith("{") || s.startsWith("[")) && looksLikeText(b);
    }
}
