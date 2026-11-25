package com.pso.spring.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

/** The authorization decision for scopes and roles must equal the shared fixture that the TypeScript orchestrator also executes. */
class AuthorizationConformanceTests {

    @Test
    void everyCaseOfTheSharedFixtureGetsTheRecordedDecision() throws Exception {
        Path file = List.of(Path.of("../../fixtures/contracts/conformance/http.json"), Path.of("../fixtures/contracts/conformance/http.json")).stream().filter(Files::exists).findFirst()
            .orElseThrow(() -> new AssertionError("fixtures/contracts/conformance/http.json not found from " + Path.of("").toAbsolutePath()));
        JsonNode cases = new ObjectMapper().readTree(Files.readString(file)).get("authorization").get("cases");
        assertThat(cases.size()).isGreaterThanOrEqualTo(12);
        for (JsonNode c : cases) {
            List<String> scopes = strings(c.get("requirement").get("scopes")), roles = strings(c.get("requirement").get("roles"));
            List<GrantedAuthority> have = new ArrayList<>();
            strings(c.get("principal").get("scopes")).forEach(s -> have.add(new SimpleGrantedAuthority("SCOPE_" + s)));
            strings(c.get("principal").get("roles")).forEach(r -> have.add(new SimpleGrantedAuthority("ROLE_" + r)));
            var decision = PsoSecurityAutoConfiguration.scopesAndRoles(scopes, roles).authorize(() -> new TestingAuthenticationToken("u", "x", have), null);
            assertThat(decision.isGranted()).as(c.get("name").asText()).isEqualTo(c.get("allowed").asBoolean());
        }
    }

    private static List<String> strings(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.asText()));
        return out;
    }
}
