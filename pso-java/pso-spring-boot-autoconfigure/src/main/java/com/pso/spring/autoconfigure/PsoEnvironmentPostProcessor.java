package com.pso.spring.autoconfigure;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Translates the declarative {@code pso.limits.*} and {@code pso.database.*} settings into the Spring Boot properties that
 * configure the real HTTP stack (Tomcat, multipart) and the embedded database. The derived property source has the LOWEST
 * precedence, so an explicit {@code server.*} or {@code spring.*} property in the application still wins.
 */
public class PsoEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    static final String SOURCE = "psoDerivedDefaults";

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE - 10; // after configuration files and profiles are loaded
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication application) {
        Binder binder = Binder.get(env);
        PsoProperties.Limits limits = binder.bind("pso.limits", PsoProperties.Limits.class).orElseGet(PsoProperties.Limits::new);
        PsoProperties.DatabaseProvider provider = binder.bind("pso.database.provider", PsoProperties.DatabaseProvider.class).orElse(PsoProperties.DatabaseProvider.NONE);

        Map<String, Object> m = new LinkedHashMap<>();
        PsoProperties.Multipart mp = limits.getMultipart();
        m.put("spring.servlet.multipart.enabled", mp.isEnabled());
        m.put("spring.servlet.multipart.max-file-size", mp.getMaxFileSize().toBytes() + "B");
        m.put("spring.servlet.multipart.max-request-size", mp.getMaxRequestSize().toBytes() + "B");
        m.put("server.max-http-request-header-size", limits.getHeader().getMaxSize().toBytes() + "B");
        m.put("server.tomcat.max-http-form-post-size", limits.getBody().getMaxSize().toBytes() + "B");
        m.put("server.tomcat.max-swallow-size", limits.getBody().getMaxSize().toBytes() + "B");
        m.put("server.tomcat.connection-timeout", limits.getTimeouts().getConnection().toMillis() + "ms");
        m.put("spring.mvc.async.request-timeout", limits.getTimeouts().getAsyncRequest().toMillis() + "ms");

        if (provider == PsoProperties.DatabaseProvider.H2) {
            String active = Arrays.toString(env.getActiveProfiles());
            for (String p : env.getActiveProfiles()) {
                if (p.equals("prod") || p.equals("staging")) {
                    throw new IllegalStateException("pso.database.provider=h2 is not allowed with the \"" + p + "\" profile (active profiles: " + active
                        + "). H2 is for local development and tests only; use postgresql.");
                }
            }
            // in-memory only: no file is ever created, the console stays off (enable it explicitly in a local-only profile if needed)
            m.put("spring.datasource.url", "jdbc:h2:mem:pso;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE");
            m.put("spring.datasource.username", "sa");
            m.put("spring.datasource.password", "");
            m.put("spring.h2.console.enabled", false);
            m.put("spring.jpa.hibernate.ddl-auto", "create-drop");
            m.put("spring.flyway.enabled", false);
        }
        if (env.getPropertySources().contains(SOURCE)) {
            env.getPropertySources().remove(SOURCE);
        }
        env.getPropertySources().addLast(new MapPropertySource(SOURCE, m));
    }
}
