package com.pso.dispatch;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The payload schema language of PSO Dispatch, with the same semantics as the TypeScript implementation: type (string, number,
 * integer, boolean, object, array, null or a list), properties, required, additionalProperties (boolean), enum, items, minimum,
 * maximum, minLength, maxLength, minItems, maxItems, pattern. Any other keyword is rejected when a schema is loaded.
 */
public final class Schemas {

    private static final Set<String> KEYWORDS = Set.of("type", "properties", "required", "additionalProperties", "enum", "items", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "description", "title");
    private static final Set<String> TYPES = Set.of("string", "number", "integer", "boolean", "object", "array", "null");

    private Schemas() {
    }

    public static List<String> problems(JsonNode s, String path) {
        List<String> p = new ArrayList<>();
        if (s == null || !s.isObject()) {
            p.add(path + ": a schema must be an object");
            return p;
        }
        for (Iterator<String> it = s.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            if (!KEYWORDS.contains(k)) {
                p.add(path + ": unsupported keyword \"" + k + "\"");
            }
        }
        JsonNode t = s.get("type");
        if (t != null) {
            for (JsonNode x : t.isArray() ? t : java.util.List.of(t)) {
                if (!x.isTextual() || !TYPES.contains(x.asText())) {
                    p.add(path + ": unknown type " + x);
                }
            }
        }
        JsonNode props = s.get("properties");
        if (props != null) {
            if (!props.isObject()) {
                p.add(path + ".properties must be an object");
            } else {
                props.fields().forEachRemaining(e -> p.addAll(problems(e.getValue(), path + "." + e.getKey())));
            }
        }
        if (s.has("items")) {
            p.addAll(problems(s.get("items"), path + "[]"));
        }
        if (s.has("pattern")) {
            try {
                Pattern.compile(s.get("pattern").asText());
            } catch (RuntimeException e) {
                p.add(path + ".pattern is not a valid expression");
            }
        }
        return p;
    }

    private static String typeOf(JsonNode v) {
        if (v.isNull()) {
            return "null";
        }
        if (v.isArray()) {
            return "array";
        }
        if (v.isObject()) {
            return "object";
        }
        if (v.isTextual()) {
            return "string";
        }
        if (v.isBoolean()) {
            return "boolean";
        }
        if (v.isIntegralNumber() || (v.isNumber() && v.doubleValue() == Math.rint(v.doubleValue()) && !v.isFloatingPointNumber())) {
            return "integer";
        }
        return "number";
    }

    /** @return validation problems for {@code value} (empty when valid); paths never include the offending values */
    public static List<String> validate(JsonNode s, JsonNode value, String path) {
        List<String> p = new ArrayList<>();
        JsonNode t = s.get("type");
        if (t != null) {
            String actual = typeOf(value);
            boolean ok = false;
            List<String> names = new ArrayList<>();
            for (JsonNode x : t.isArray() ? t : java.util.List.of(t)) {
                names.add(x.asText());
                if (x.asText().equals(actual) || (x.asText().equals("number") && actual.equals("integer"))) {
                    ok = true;
                }
            }
            if (!ok) {
                p.add(path + ": expected " + String.join("|", names) + ", got " + actual);
                return p;
            }
        }
        JsonNode en = s.get("enum");
        if (en != null) {
            boolean found = false;
            for (JsonNode x : en) {
                if (x.equals(value)) {
                    found = true;
                }
            }
            if (!found) {
                p.add(path + ": not one of the allowed values");
            }
        }
        if (value.isTextual()) {
            String text = value.asText();
            if (s.has("minLength") && text.codePointCount(0, text.length()) < s.get("minLength").asInt()) {
                p.add(path + ": shorter than " + s.get("minLength").asInt());
            }
            if (s.has("maxLength") && text.codePointCount(0, text.length()) > s.get("maxLength").asInt()) {
                p.add(path + ": longer than " + s.get("maxLength").asInt());
            }
            if (s.has("pattern") && !Pattern.compile(s.get("pattern").asText()).matcher(text).find()) {
                p.add(path + ": does not match the required pattern");
            }
        }
        if (value.isNumber()) {
            if (s.has("minimum") && value.doubleValue() < s.get("minimum").doubleValue()) {
                p.add(path + ": below " + s.get("minimum"));
            }
            if (s.has("maximum") && value.doubleValue() > s.get("maximum").doubleValue()) {
                p.add(path + ": above " + s.get("maximum"));
            }
        }
        if (value.isArray()) {
            if (s.has("minItems") && value.size() < s.get("minItems").asInt()) {
                p.add(path + ": fewer than " + s.get("minItems").asInt() + " items");
            }
            if (s.has("maxItems") && value.size() > s.get("maxItems").asInt()) {
                p.add(path + ": more than " + s.get("maxItems").asInt() + " items");
            }
            if (s.has("items")) {
                int i = 0;
                for (JsonNode x : value) {
                    p.addAll(validate(s.get("items"), x, path + "[" + i++ + "]"));
                }
            }
        }
        if (value.isObject()) {
            JsonNode req = s.get("required");
            if (req != null) {
                for (JsonNode r : req) {
                    if (!value.has(r.asText())) {
                        p.add(path + "." + r.asText() + ": is required");
                    }
                }
            }
            JsonNode props = s.get("properties");
            for (Iterator<String> it = value.fieldNames(); it.hasNext(); ) {
                String k = it.next();
                JsonNode sub = props == null ? null : props.get(k);
                if (sub != null) {
                    p.addAll(validate(sub, value.get(k), path + "." + k));
                } else if (s.has("additionalProperties") && !s.get("additionalProperties").asBoolean(true)) {
                    p.add(path + "." + k + ": is not allowed");
                }
            }
        }
        return p;
    }
}
