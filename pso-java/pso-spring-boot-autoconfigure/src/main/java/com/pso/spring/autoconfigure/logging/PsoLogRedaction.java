package com.pso.spring.autoconfigure.logging;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Removes secrets from log text before it is written. It mirrors the rules of the Node orchestrator logger: JWTs, bearer/basic credentials,
 * credentials inside URLs and key=value pairs for password, secret, token and api key. It is applied to structured (JSON) log output through
 * {@link PsoStructuredLogRedaction}; the pattern (console) layout is for developers and is not rewritten.
 */
public final class PsoLogRedaction {

    public static final String REDACTED = "[REDACTED]";
    private static final Pattern JWT = Pattern.compile("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b");
    private static final Pattern BEARER = Pattern.compile("\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{8,}", Pattern.CASE_INSENSITIVE);
    private static final Pattern URL_CREDENTIALS = Pattern.compile("\\b([a-z][a-z0-9+.-]*://)([^\\s/:@]+):([^\\s/@]+)@", Pattern.CASE_INSENSITIVE);
    private static final Pattern PAIR = Pattern.compile("\\b(password|passwd|secret|token|api[-_]?key)=([^\\s&;,]+)", Pattern.CASE_INSENSITIVE);

    private PsoLogRedaction() {
    }

    public static String redact(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        String out = JWT.matcher(text).replaceAll(Matcher.quoteReplacement(REDACTED));
        out = BEARER.matcher(out).replaceAll(m -> Matcher.quoteReplacement(m.group(1) + " " + REDACTED));
        out = URL_CREDENTIALS.matcher(out).replaceAll(m -> Matcher.quoteReplacement(m.group(1) + REDACTED + "@"));
        out = PAIR.matcher(out).replaceAll(m -> Matcher.quoteReplacement(m.group(1) + "=" + REDACTED));
        return out;
    }
}
