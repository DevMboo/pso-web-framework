package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pso.it.app.TestApp;
import com.pso.it.dup.DupApp;
import com.pso.spring.autoconfigure.PsoPrefix;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;

class PrefixAndConfigurationTests {

    @Test
    void ideMetadataIsGeneratedForEveryPsoProperty() throws Exception {
        try (var in = getClass().getResourceAsStream("/META-INF/spring-configuration-metadata.json")) {
            assertThat(in).as("configuration metadata for IDE completion").isNotNull();
            String json = new String(in.readAllBytes());
            for (String key : new String[] {"pso.security.cors.allowed-origins", "pso.limits.body.max-size", "pso.database.provider", "pso.dispatch.enabled", "pso.service.prefix", "pso.http.client.services"}) {
                assertThat(json).contains("\"" + key + "\"");
            }
        }
    }

    @Test
    void prefixIsDerivedFromTheServiceName() {
        assertThat(PsoPrefix.derive("users-service")).isEqualTo("/users");
        assertThat(PsoPrefix.derive("orders-service")).isEqualTo("/orders");
        assertThat(PsoPrefix.derive("notification-service")).isEqualTo("/notification");
        assertThat(PsoPrefix.derive("billing")).isEqualTo("/billing");
        assertThat(PsoPrefix.derive("service")).isEqualTo("/service");
    }

    @Test
    void prefixesAreNormalizedAndInvalidOnesRejected() {
        assertThat(PsoPrefix.normalize("users")).isEqualTo("/users");
        assertThat(PsoPrefix.normalize("//users//")).isEqualTo("/users");
        assertThat(PsoPrefix.normalize("/api/v1/")).isEqualTo("/api/v1");
        assertThat(PsoPrefix.normalize("/")).isEmpty();
        assertThat(PsoPrefix.normalize("")).isEmpty();
        for (String bad : new String[] {"/Users", "/a b", "/../x", "/a/./b", "/a?x=1", "/a#f", "http://x", "/%2e%2e"}) {
            assertThatThrownBy(() -> PsoPrefix.normalize(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service", "pso.limits.requests.per-minute=100000", "management.endpoint.health.probes.enabled=true"})
    @Nested
    class Derived extends Base {
        @Autowired PsoServiceInfo info;

        @Test
        void controllersAreServedUnderTheDerivedPrefixExactlyOnce() {
            assertThat(info.prefix()).isEqualTo("/users");
            assertThat(Http.get(port, "/users/customers/42", token()).statusCode()).isEqualTo(200);
            assertThat(Http.get(port, "/users/customers/42", token()).body()).contains("\"id\":\"42\"");
            assertThat(Http.get(port, "/customers/42", token()).statusCode()).as("the unprefixed path does not exist").isEqualTo(404);
            assertThat(Http.get(port, "/users/users/customers/42", token()).statusCode()).as("never served twice").isEqualTo(404);
        }

        @Test
        void unprefixedControllersAndActuatorKeepTheirPaths() {
            assertThat(Http.get(port, "/root-ping", token()).statusCode()).isEqualTo(200);
            assertThat(Http.get(port, "/actuator/health", null).statusCode()).isEqualTo(200);
            assertThat(Http.get(port, "/actuator/health/liveness", null).statusCode()).isEqualTo(200);
        }

        @Test
        void correlationIdIsEchoedOrGenerated() {
            var generated = Http.get(port, "/actuator/health", null);
            assertThat(generated.headers().firstValue("X-Correlation-ID")).isPresent();
            var echoed = Http.send(Http.req(port, "/actuator/health", null).header("X-Correlation-ID", "abc12345-trace").GET());
            assertThat(echoed.headers().firstValue("X-Correlation-ID")).contains("abc12345-trace");
            var forged = Http.send(Http.req(port, "/actuator/health", null).header("X-Correlation-ID", "bad value\twith spaces").GET());
            assertThat(forged.headers().firstValue("X-Correlation-ID").orElse("")).doesNotContain(" ").hasSize(36);
        }
    }

    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service", "pso.service.prefix=billing/", "pso.limits.requests.per-minute=100000"})
    @Nested
    class Explicit extends Base {
        @Test
        void explicitPrefixOverridesTheDerivedOne() {
            assertThat(Http.get(port, "/billing/customers/1", token()).statusCode()).isEqualTo(200);
            assertThat(Http.get(port, "/users/customers/1", token()).statusCode()).isEqualTo(404);
        }
    }

    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service", "pso.service.prefix=/", "pso.limits.requests.per-minute=100000"})
    @Nested
    class NoPrefix extends Base {
        @Test
        void slashDisablesThePrefix() {
            assertThat(Http.get(port, "/customers/1", token()).statusCode()).isEqualTo(200);
        }
    }

    private static Throwable startFailure(Class<?> app, String... props) {
        String[] all = new String[props.length + 3];
        System.arraycopy(props, 0, all, 0, props.length);
        all[props.length] = "server.port=0";
        all[props.length + 1] = "spring.main.banner-mode=off";
        all[props.length + 2] = "logging.level.root=OFF";
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(app).properties(all).run()) {
            throw new AssertionError("the application was expected to refuse to start");
        } catch (AssertionError e) {
            throw e;
        } catch (Throwable t) {
            return t;
        }
    }

    private static String messages(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) {
            sb.append(c.getMessage()).append('\n');
        }
        return sb.toString();
    }

    @Test
    void misspelledPsoPropertiesAreNotSilentlyIgnored() {
        String m = messages(startFailure(TestApp.class, "pso.service.name=users-service", "pso.security.cors.allowed-origin=http://localhost:3000"));
        assertThat(m).contains("pso.security.cors.allowed-origin");
        String m2 = messages(startFailure(TestApp.class, "pso.service.name=users-service", "pso.securty.jwt.issuer=x"));
        assertThat(m2).contains("pso.securty");
    }

    @Test
    void invalidServiceNameAndPrefixAndLimitsAreRejected() {
        assertThat(messages(startFailure(TestApp.class, "pso.service.name=Users_Service"))).contains("kebab-case");
        assertThat(messages(startFailure(TestApp.class, "pso.service.name=users-service", "pso.service.prefix=/Bad Prefix"))).contains("pso.service.prefix");
        assertThat(messages(startFailure(TestApp.class, "pso.service.name=users-service", "pso.limits.requests.per-minute=0"))).containsIgnoringCase("perMinute");
        assertThat(messages(startFailure(TestApp.class, "pso.service.name=users-service", "pso.limits.body.max-size=lots"))).containsIgnoringCase("max-size");
    }

    @Test
    void aMissingServiceNameFailsWithAnActionableMessage() {
        assertThat(messages(startFailure(TestApp.class))).contains("pso.service.name is required");
    }

    @Test
    void contextPathPlusPrefixWouldDuplicateAndIsRefused() {
        assertThat(messages(startFailure(TestApp.class, "pso.service.name=users-service", "server.servlet.context-path=/users"))).contains("duplicate the prefix");
    }

    @Test
    void aControllerThatAlreadyContainsThePrefixIsRefused() {
        String m = messages(startFailure(DupApp.class, "pso.service.name=users-service"));
        assertThat(m).contains("already contain it").contains("/users/users/x");
        assertThat(m).contains("@RepeatsServicePrefix");
    }

    /** CLI-01: a resource named like the service is legitimate when the controller declares it; the prefix is still applied once. */
    @Test
    void aControllerThatDeclaresTheRepetitionStartsAndIsServedUnderThePrefix() throws Exception {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.pso.it.intended.IntendedApp.class)
                .properties("pso.service.name=users-service", "server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
            java.util.Set<String> patterns = new java.util.TreeSet<>();
            ctx.getBean("requestMappingHandlerMapping", org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping.class)
                .getHandlerMethods().keySet().forEach(i -> { if (i.getPathPatternsCondition() != null) { patterns.addAll(i.getPathPatternsCondition().getPatternValues()); } });
            assertThat(patterns).contains("/users/users", "/users/users/archive", "/users/profiles");
            assertThat(patterns).doesNotContain("/users", "/users/users/users");
            // real HTTP: the declared path exists (the security filter answers 401 for it without a token) and is not served twice-prefixed or unprefixed
            int port = Integer.parseInt(ctx.getEnvironment().getProperty("local.server.port"));
            java.net.http.HttpClient http = java.net.http.HttpClient.newHttpClient();
            for (String path : new String[] {"/users/users", "/users/users/archive", "/users/profiles"}) {
                int status = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + path)).build(), java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode();
                assertThat(status).as(path).isEqualTo(401);
            }
        }
    }

    @Test
    void theDeclarationCoversOnlyTheControllerThatCarriesIt() {
        String m = messages(startFailure(com.pso.it.mixed.MixedApp.class, "pso.service.name=users-service"));
        assertThat(m).contains("already contain it").contains("/users/users/settings").doesNotContain("[/users/users,").doesNotContain("/users/users]");
    }
}
