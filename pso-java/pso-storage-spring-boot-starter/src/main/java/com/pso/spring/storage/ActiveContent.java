package com.pso.spring.storage;

import java.util.Set;
import java.util.regex.Pattern;

/** Content types that a browser may execute or interpret as a document with script. Such files are never served inline and never with their own type. */
public final class ActiveContent {

    private static final Set<String> ACTIVE = Set.of("text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "text/javascript",
        "application/javascript", "application/x-javascript", "text/css", "application/x-shockwave-flash", "application/hta", "text/x-component");
    private static final Pattern MEDIA_TYPE = Pattern.compile("^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$");

    private ActiveContent() {
    }

    public static boolean isActive(String contentType) {
        String t = FileSignatures.normalize(contentType);
        return ACTIVE.contains(t) || t.endsWith("+xml") || t.startsWith("text/html");
    }

    /** The type to send to a client: the stored one when it is a well-formed, non-active type; otherwise {@code application/octet-stream}. */
    public static String safeType(String contentType) {
        String t = FileSignatures.normalize(contentType);
        return MEDIA_TYPE.matcher(t).matches() && !isActive(t) ? t : "application/octet-stream";
    }
}
