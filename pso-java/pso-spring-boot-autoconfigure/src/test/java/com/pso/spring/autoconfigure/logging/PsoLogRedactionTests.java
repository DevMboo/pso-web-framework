package com.pso.spring.autoconfigure.logging;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.json.JsonWriter;

/** The same redaction rules as packages/http/src/logger.ts (the Node tests assert the same samples). */
class PsoLogRedactionTests {

    private static final String JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

    @Test
    void removesJwtsBearerCredentialsUrlCredentialsAndKeyValueSecrets() {
        String in = "calling https://user:pw@host/path with Bearer " + JWT + " token=abc123 password=hunter2 and redis://app:s3cret@db:6379";
        String out = PsoLogRedaction.redact(in);
        for (String secret : new String[] {"user:pw", JWT, "abc123", "hunter2", "s3cret", "eyJhbGci"}) {
            assertThat(out).doesNotContain(secret);
        }
        assertThat(out).contains("https://[REDACTED]@host/path").contains("Bearer [REDACTED]").contains("token=[REDACTED]").contains("redis://[REDACTED]@db:6379");
    }

    @Test
    void leavesOrdinaryTextAndNullAlone() {
        assertThat(PsoLogRedaction.redact("order 42 created for customer Grace")).isEqualTo("order 42 created for customer Grace");
        assertThat(PsoLogRedaction.redact(null)).isNull();
        assertThat(PsoLogRedaction.redact("")).isEmpty();
        assertThat(PsoLogRedaction.redact("Basic dXNlcjpwYXNzd29yZA==")).isEqualTo("Basic [REDACTED]");
    }

    @Test
    void theStructuredLoggingCustomizerRedactsEveryStringMember() {
        JsonWriter<Map<String, String>> writer = JsonWriter.<Map<String, String>>of(members -> {
            members.add("message", m -> m.get("message"));
            members.add("note", m -> m.get("note"));
            members.add("count", m -> 3);
            @SuppressWarnings({"unchecked", "rawtypes"})
            JsonWriter.Members<Object> generic = (JsonWriter.Members) members;
            new PsoStructuredLogRedaction().customize(generic);
        });
        String json = writer.writeToString(Map.of("message", "token=abc123 calling redis://app:s3cret@db", "note", "Bearer " + JWT));
        assertThat(json).doesNotContain("abc123").doesNotContain("s3cret").doesNotContain("eyJhbGci");
        assertThat(json).contains("token=[REDACTED]").contains("\"count\":3");
    }
}
