package com.pso.spring.storage;

import java.time.Instant;

/**
 * Published (Spring {@code ApplicationEvent} payload) for every storage operation, allowed or not. It carries identifiers only: never
 * content, never a filename, key or provider detail. Listen with {@code @EventListener} to feed an audit trail.
 *
 * @param outcome ALLOWED, DENIED or FAILED
 * @param reason  short fixed code for DENIED/FAILED (e.g. policy, not-found, too-large, invalid, scanner, provider)
 */
public record StorageAuditEvent(Instant at, StorageAccess.Operation operation, String fileId, String subject, String outcome, String reason) {
}
