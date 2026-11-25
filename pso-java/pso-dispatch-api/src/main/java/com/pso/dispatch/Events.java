package com.pso.dispatch;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Event contract declarations and the registry the runtime enforces. The declaration is what permits publishing an event. */
public final class Events {

    private Events() {
    }

    /**
     * @param schema        payload schema in the dispatch schema language (nullable)
     * @param accepts       older versions this service still accepts when consuming
     * @param publish       may this service publish the event (default true)
     * @param key           dotted payload path used as the partition / ordering key (nullable)
     * @param compatibility backward, forward, full or none
     */
    public record Decl(String name, int version, String channel, JsonNode schema, String compatibility, List<Integer> accepts, boolean publish, String key) {
        public Decl {
            accepts = accepts == null ? List.of() : List.copyOf(accepts);
        }
    }

    /** @return problems of a declaration (empty when valid) */
    public static List<String> problems(Decl d) {
        List<String> p = new ArrayList<>();
        String at = "event \"" + d.name() + "\"";
        if (!Envelope.isEventName(d.name())) {
            p.add(at + ": invalid name (dotted lower-case, e.g. users.created)");
        }
        if (d.version() < 1) {
            p.add(at + ": version must be an integer >= 1");
        }
        if (!Envelope.isChannelName(d.channel())) {
            p.add(at + ": invalid channel");
        }
        if (d.compatibility() != null && !List.of("backward", "forward", "full", "none").contains(d.compatibility())) {
            p.add(at + ": unknown compatibility policy");
        }
        for (int v : d.accepts()) {
            if (v < 1 || v >= d.version()) {
                p.add(at + ": accepts must list older versions");
            }
        }
        if (d.schema() != null) {
            Schemas.problems(d.schema(), "$").forEach(x -> p.add(at + ": " + x));
        }
        return p;
    }

    public static final class Registry {
        private final Map<String, Decl> byName = new LinkedHashMap<>();

        public void add(Decl d) {
            List<String> bad = problems(d);
            if (!bad.isEmpty()) {
                throw new DispatchException("PSO_DISPATCH_EVENTS_INVALID", String.join("; ", bad));
            }
            Decl prev = byName.get(d.name());
            if (prev != null) {
                if (prev.version() == d.version()) {
                    throw new DispatchException("PSO_DISPATCH_EVENT_DUPLICATE", "event \"" + d.name() + "\" is declared more than once");
                }
                if (!prev.channel().equals(d.channel())) {
                    throw new DispatchException("PSO_DISPATCH_EVENTS_INVALID", "event \"" + d.name() + "\" is declared on two channels");
                }
                if (prev.version() > d.version()) {
                    return;
                }
            }
            byName.put(d.name(), d);
        }

        public Decl get(String name) {
            return byName.get(name);
        }

        public Collection<Decl> all() {
            return byName.values();
        }
    }
}
