package {{pkg}};

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.PsoDispatch;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

/** The foundations every PSO service keeps, with or without the reference CRUD: health, security by default, opt-in database and dispatch. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ApplicationTests {

    @Autowired
    MockMvc mvc;

    @Autowired
    PsoServiceInfo service;

    @Autowired
    ApplicationContext context;

    @Test
    void healthIsPublic() throws Exception {
        mvc.perform(get("/actuator/health")).andExpect(status().isOk());
    }

    @Test
    void aDatabaseExistsExactlyWhenOneWasChosen() {
        String provider = context.getEnvironment().getProperty("pso.database.provider", "none");
        boolean hasDataSource = context.getBeanNamesForType(DataSource.class).length > 0;
        assertEquals(!"none".equals(provider), hasDataSource, "pso.database.provider=" + provider);
    }

    @Test
    void dispatchConnectsToNothingUnlessItIsEnabled() {
        boolean enabled = Boolean.parseBoolean(context.getEnvironment().getProperty("pso.dispatch.enabled", "false"));
        assertEquals(enabled, context.getBeanNamesForType(DispatchAdapter.class).length > 0, "a broker adapter exists exactly when dispatch is enabled");
        assertEquals(!enabled, context.getBean(PsoDispatch.class) instanceof PsoDispatch.Disabled, "while dispatch is disabled the injected PsoDispatch refuses to publish");
    }

    @Test
    void theServicePrefixMatchesTheWorkspaceDeclaration() {
        assertEquals("{{prefix}}", service.prefix());
    }

    @Test
    void aForgedBearerTokenIsRejected() throws Exception {
        mvc.perform(get("/anything").header("Authorization", "Bearer aaa.bbb.ccc")).andExpect(status().isUnauthorized());
    }

    @Test
    void everythingElseIsDeniedByDefault() throws Exception {
        mvc.perform(get("/anything")).andExpect(status().isUnauthorized());
    }
}
