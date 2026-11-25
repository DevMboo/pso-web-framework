package com.pso.orders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.pso.spring.autoconfigure.PsoServiceInfo;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.junit.jupiter.api.Assertions.assertEquals;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ApplicationTests {

    @Autowired
    MockMvc mvc;

    @Autowired
    PsoServiceInfo service;

    @Test
    void healthIsPublic() throws Exception {
        mvc.perform(get("/actuator/health")).andExpect(status().isOk());
    }

    @Autowired
    org.springframework.context.ApplicationContext context;

    @Test
    void noDatabaseIsStartedUnlessOneWasChosen() {
        String provider = context.getEnvironment().getProperty("pso.database.provider", "none");
        boolean hasDataSource = context.getBeanNamesForType(javax.sql.DataSource.class).length > 0;
        assertEquals(!"none".equals(provider), hasDataSource, "pso.database.provider=" + provider);
    }

    @Test
    void dispatchConnectsToNothingUnlessItIsEnabled() {
        boolean enabled = Boolean.parseBoolean(context.getEnvironment().getProperty("pso.dispatch.enabled", "false"));
        boolean hasAdapter = context.getBeanNamesForType(com.pso.dispatch.DispatchAdapter.class).length > 0;
        assertEquals(enabled, hasAdapter, "pso.dispatch.enabled=" + enabled + ": a broker adapter exists exactly when dispatch is enabled");
        boolean disabledDispatch = context.getBean(com.pso.dispatch.PsoDispatch.class) instanceof com.pso.dispatch.PsoDispatch.Disabled;
        assertEquals(!enabled, disabledDispatch, "while dispatch is disabled the injected PsoDispatch refuses to publish, so nothing can connect");
    }

    @Test
    void theServicePrefixMatchesTheWorkspaceDeclaration() {
        assertEquals("/orders", service.prefix());
    }

    @Test
    void bearerTokenIsRejectedWhenJwtIsNotConfigured() throws Exception {
        mvc.perform(get("/anything").header("Authorization", "Bearer aaa.bbb.ccc")).andExpect(status().isUnauthorized());
    }

    @Test
    void everythingElseIsDeniedByDefault() throws Exception {
        mvc.perform(get("/anything")).andExpect(status().isUnauthorized());
    }
}
