package com.pso.spring.autoconfigure;

import java.util.Set;
import org.springframework.boot.autoconfigure.AutoConfigurationImportFilter;
import org.springframework.boot.autoconfigure.AutoConfigurationMetadata;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.env.Environment;

/**
 * When {@code pso.database.provider} is {@code none} (the default), database auto-configuration is removed entirely, so the
 * service starts without a JDBC URL, a driver, JPA or Flyway even if those libraries happen to be on the classpath.
 */
public class DatabaseProviderImportFilter implements AutoConfigurationImportFilter, EnvironmentAware {

    private static final Set<String> DATABASE = Set.of(
        "org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration",
        "org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration",
        "org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration",
        "org.springframework.boot.autoconfigure.jdbc.JdbcClientAutoConfiguration",
        "org.springframework.boot.autoconfigure.jdbc.XADataSourceAutoConfiguration",
        "org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration",
        "org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration",
        "org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration",
        "org.springframework.boot.autoconfigure.sql.init.SqlInitializationAutoConfiguration");

    private boolean none = true;

    @Override
    public void setEnvironment(Environment environment) {
        String p = environment.getProperty("pso.database.provider", "none").trim();
        this.none = p.equalsIgnoreCase("none") || p.isEmpty();
    }

    @Override
    public boolean[] match(String[] autoConfigurationClasses, AutoConfigurationMetadata metadata) {
        boolean[] out = new boolean[autoConfigurationClasses.length];
        for (int i = 0; i < out.length; i++) {
            out[i] = !(none && autoConfigurationClasses[i] != null && DATABASE.contains(autoConfigurationClasses[i]));
        }
        return out;
    }
}
