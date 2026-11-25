package com.pso.spring.autoconfigure.logging;

import org.springframework.boot.json.JsonWriter;
import org.springframework.boot.logging.structured.StructuredLoggingJsonMembersCustomizer;

/**
 * Redacts every string member (message, stack trace, MDC values) of Spring Boot's structured JSON logging. Enable it with
 * {@code logging.structured.json.customizer=com.pso.spring.autoconfigure.logging.PsoStructuredLogRedaction}; the prod profile of generated
 * services does. It is a standard Spring Boot extension point, not a logging framework of its own.
 */
public class PsoStructuredLogRedaction implements StructuredLoggingJsonMembersCustomizer<Object> {

    @Override
    public void customize(JsonWriter.Members<Object> members) {
        members.applyingValueProcessor(JsonWriter.ValueProcessor.of(String.class, PsoLogRedaction::redact));
    }
}
