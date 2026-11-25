package com.pso.spring.http;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class BearerPolicyTests {

    @Test
    void aTokenNeverTravelsInClearTextBetweenHosts() {
        assertThat(BearerPolicy.refusal(false, null, List.of("any"))).contains("plain http");
        assertThat(BearerPolicy.refusal(true, null, List.of())).isNull();
    }

    @Test
    void whenAnAudienceIsRequiredTheTokenMustNameIt() {
        assertThat(BearerPolicy.refusal(true, "billing-api", List.of("billing-api", "other"))).isNull();
        assertThat(BearerPolicy.refusal(true, "billing-api", List.of("other"))).contains("billing-api");
        assertThat(BearerPolicy.refusal(true, "billing-api", List.of())).as("a token without audience cannot satisfy a required one").isNotNull();
        assertThat(BearerPolicy.refusal(false, "billing-api", List.of("billing-api"))).as("transport is checked first").contains("plain http");
    }
}
