package com.pso.dispatch;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The canonical wire contract, identical in TypeScript and Java (envelope version 1). Serialized as UTF-8 JSON in canonical form: fixed
 * envelope field order, payload keys sorted. No Java class names appear on the wire.
 */
public record Envelope(String id, String type, int version, String source, String occurredAt, String correlationId, String causationId,
                       Trace trace, JsonNode payload) {

    public record Trace(String traceparent, String tracestate) {
    }

    public static final int MAX_BYTES = 1_048_576;
    private static final int MAX_META = 256;
    private static final int MAX_DEPTH = 32;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static final Pattern TYPE = Pattern.compile("^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*)+$");
    private static final Pattern SOURCE = Pattern.compile("^[a-z][a-z0-9]*(-[a-z0-9]+)*$");
    private static final Pattern TIME = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$");
    private static final Pattern TRACEPARENT = Pattern.compile("^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$");
    private static final Set<String> FIELDS = Set.of("envelopeVersion", "id", "type", "version", "source", "occurredAt", "correlationId", "causationId", "trace", "contentType", "payload");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static boolean isEventName(String s) {
        return s != null && TYPE.matcher(s).matches();
    }

    public static boolean isChannelName(String s) {
        return s != null && s.length() <= 100 && s.matches("^[a-z][a-z0-9]*([._-][a-z0-9]+)*$");
    }

    public static Envelope create(String type, int version, String source, JsonNode payload, String correlationId, String causationId, Trace trace, String id) {
        Envelope e = new Envelope(id != null ? id : UUID.randomUUID().toString(), type, version, source,
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC).format(Instant.now()),
            correlationId != null ? correlationId : UUID.randomUUID().toString(), causationId, trace, payload);
        List<String> bad = problems(e.toTree());
        if (!bad.isEmpty()) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_INVALID", "invalid envelope: " + String.join("; ", bad));
        }
        return e;
    }

    /** @return the problems of an untrusted envelope tree (empty when valid). Unknown top-level fields are rejected. */
    public static List<String> problems(JsonNode n) {
        List<String> p = new ArrayList<>();
        if (n == null || !n.isObject()) {
            p.add("envelope must be a JSON object");
            return p;
        }
        for (Iterator<String> it = n.fieldNames(); it.hasNext(); ) {
            String f = it.next();
            if (!FIELDS.contains(f)) {
                p.add("unknown field \"" + f + "\"");
            }
        }
        if (!(n.has("envelopeVersion") && n.get("envelopeVersion").isInt() && n.get("envelopeVersion").intValue() == 1)) {
            p.add("envelopeVersion must be 1");
        }
        str(n, "id", ID, true, p);
        str(n, "type", TYPE, true, p);
        str(n, "source", SOURCE, true, p);
        str(n, "occurredAt", TIME, true, p);
        str(n, "correlationId", ID, true, p);
        str(n, "causationId", ID, false, p);
        JsonNode v = n.get("version");
        if (v == null || !v.isIntegralNumber() || v.longValue() < 1) {
            p.add("version must be an integer >= 1");
        }
        if (!(n.has("contentType") && n.get("contentType").isTextual() && n.get("contentType").asText().equals("application/json"))) {
            p.add("contentType must be application/json");
        }
        if (!n.has("payload")) {
            p.add("payload is required");
        } else if (depth(n.get("payload"), 0) > MAX_DEPTH) {
            p.add("payload is nested too deeply");
        }
        JsonNode t = n.get("trace");
        if (t != null) {
            if (!t.isObject()) {
                p.add("trace must be an object");
            } else {
                for (Iterator<String> it = t.fieldNames(); it.hasNext(); ) {
                    String f = it.next();
                    if (!f.equals("traceparent") && !f.equals("tracestate")) {
                        p.add("unknown trace field \"" + f + "\"");
                    }
                }
                if (!t.has("traceparent") || !t.get("traceparent").isTextual() || !TRACEPARENT.matcher(t.get("traceparent").asText()).matches()) {
                    p.add("trace.traceparent is invalid");
                }
                if (t.has("tracestate") && (!t.get("tracestate").isTextual() || t.get("tracestate").asText().length() > 512)) {
                    p.add("trace.tracestate is invalid");
                }
            }
        }
        return p;
    }

    private static void str(JsonNode n, String k, Pattern re, boolean required, List<String> p) {
        JsonNode v = n.get(k);
        if (v == null) {
            if (required) {
                p.add(k + " is required");
            }
            return;
        }
        if (!v.isTextual() || v.asText().length() > MAX_META || !re.matcher(v.asText()).matches()) {
            p.add(k + " is invalid");
        }
    }

    private static int depth(JsonNode n, int d) {
        if (d > MAX_DEPTH) {
            return d;
        }
        int max = d;
        for (JsonNode c : n) {
            max = Math.max(max, depth(c, d + 1));
        }
        return max;
    }

    private static JsonNode sorted(JsonNode n) {
        if (n.isObject()) {
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            new TreeSet<String>(iterable(n.fieldNames())).forEach(k -> out.set(k, sorted(n.get(k))));
            return out;
        }
        if (n.isArray()) {
            ArrayNode out = JsonNodeFactory.instance.arrayNode();
            n.forEach(c -> out.add(sorted(c)));
            return out;
        }
        return n;
    }

    private static List<String> iterable(Iterator<String> it) {
        List<String> l = new ArrayList<>();
        it.forEachRemaining(l::add);
        return l;
    }

    /** The envelope as an ordered tree (canonical field order, payload keys sorted). */
    public ObjectNode toTree() {
        ObjectNode o = JsonNodeFactory.instance.objectNode();
        o.put("envelopeVersion", 1);
        o.put("id", id);
        o.put("type", type);
        o.put("version", version);
        o.put("source", source);
        o.put("occurredAt", occurredAt);
        o.put("correlationId", correlationId);
        if (causationId != null) {
            o.put("causationId", causationId);
        }
        if (trace != null) {
            ObjectNode t = o.putObject("trace");
            t.put("traceparent", trace.traceparent());
            if (trace.tracestate() != null) {
                t.put("tracestate", trace.tracestate());
            }
        }
        o.put("contentType", "application/json");
        o.set("payload", sorted(payload));
        return o;
    }

    /** Canonical JSON, the same bytes TypeScript produces (payload numbers must be integers or exact decimals). */
    public String serialize() {
        List<String> bad = problems(toTree());
        if (!bad.isEmpty()) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_INVALID", "invalid envelope: " + String.join("; ", bad));
        }
        try {
            String text = MAPPER.writeValueAsString(toTree());
            if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
                throw new DispatchException("PSO_DISPATCH_ENVELOPE_TOO_LARGE", "envelope exceeds " + MAX_BYTES + " bytes");
            }
            return text;
        } catch (JsonProcessingException e) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_INVALID", "envelope cannot be serialized");
        }
    }

    public byte[] bytes() {
        return serialize().getBytes(StandardCharsets.UTF_8);
    }

    /** Parses untrusted bytes into plain JSON data (no polymorphic typing, no class instantiation). */
    public static Envelope parse(byte[] raw, int maxBytes) {
        if (raw.length > maxBytes) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_TOO_LARGE", "message exceeds " + maxBytes + " bytes");
        }
        JsonNode n;
        try {
            n = MAPPER.readTree(raw);
        } catch (java.io.IOException e) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_INVALID", "message is not valid JSON");
        }
        List<String> bad = problems(n);
        if (!bad.isEmpty()) {
            throw new DispatchException("PSO_DISPATCH_ENVELOPE_INVALID", "invalid envelope: " + String.join("; ", bad));
        }
        JsonNode t = n.get("trace");
        return new Envelope(n.get("id").asText(), n.get("type").asText(), n.get("version").intValue(), n.get("source").asText(), n.get("occurredAt").asText(),
            n.get("correlationId").asText(), n.has("causationId") ? n.get("causationId").asText() : null,
            t == null ? null : new Trace(t.get("traceparent").asText(), t.has("tracestate") ? t.get("tracestate").asText() : null), n.get("payload"));
    }

    public static Envelope parse(byte[] raw) {
        return parse(raw, MAX_BYTES);
    }
}
