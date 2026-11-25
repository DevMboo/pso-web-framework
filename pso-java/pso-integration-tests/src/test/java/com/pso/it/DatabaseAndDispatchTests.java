package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.it.app.TestApp;
import javax.sql.DataSource;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

class DatabaseAndDispatchTests {

    /** JPA, Flyway, the PostgreSQL driver and H2 are ALL on this classpath; with provider none nothing database-related starts. */
    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service"})
    class DatabaseNoneByDefault extends Base {
        @Autowired ApplicationContext ctx;

        @Test
        void startsWithoutAnyDatabaseEvenThoughDriversAreOnTheClasspath() {
            assertThat(ctx.getBeanNamesForType(DataSource.class)).isEmpty();
            assertThat(ctx.getBeanNamesForType(jakarta.persistence.EntityManagerFactory.class)).isEmpty();
            assertThat(ctx.getBeanNamesForType(org.flywaydb.core.Flyway.class)).isEmpty();
            assertThat(Http.get(port, "/actuator/health", null).statusCode()).isEqualTo(200);
            assertThat(Http.get(port, "/actuator/health", null).body()).doesNotContain("\"db\"");
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service", "pso.database.provider=h2"})
    class H2Explicit extends Base {
        @Autowired DataSource dataSource;
        @Autowired JdbcTemplate jdbc;
        @Autowired org.springframework.core.env.Environment env;

        @Test
        void h2IsInMemoryWithTheConsoleOff() throws Exception {
            assertThat(jdbc.queryForObject("select 1", Integer.class)).isEqualTo(1);
            try (var c = dataSource.getConnection()) {
                assertThat(c.getMetaData().getURL()).startsWith("jdbc:h2:mem:");
            }
            assertThat(env.getProperty("spring.h2.console.enabled")).isEqualTo("false");
            assertThat(Http.get(port, "/h2-console", token()).statusCode()).as("no console is exposed").isEqualTo(404);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.database.provider=postgresql",
        "spring.datasource.url=jdbc:postgresql://127.0.0.1:1/pso", "spring.datasource.username=pso", "spring.datasource.password=unused",
        "spring.jpa.hibernate.ddl-auto=none", "spring.jpa.database-platform=org.hibernate.dialect.PostgreSQLDialect",
        "spring.jpa.properties.hibernate.boot.allow_jdbc_metadata_access=false", "spring.flyway.enabled=false", "spring.sql.init.mode=never",
        "spring.datasource.hikari.initialization-fail-timeout=-1", "management.health.db.enabled=false"})
    class PostgresqlActivation extends Base {
        @Autowired ApplicationContext ctx;

        @Test
        void selectingPostgresqlActivatesTheDatabaseIntegrationsWithoutTheH2Defaults() throws Exception {
            DataSource ds = ctx.getBean(DataSource.class);
            assertThat(ds).isInstanceOf(com.zaxxer.hikari.HikariDataSource.class);
            assertThat(((com.zaxxer.hikari.HikariDataSource) ds).getJdbcUrl()).startsWith("jdbc:postgresql://");
            assertThat(ctx.getBeanNamesForType(jakarta.persistence.EntityManagerFactory.class)).isNotEmpty();
            assertThat(ctx.getEnvironment().getProperty("spring.h2.console.enabled")).isNull();
            // a real connection is NOT attempted here: no PostgreSQL server is available in this environment
        }
    }

    private static String failure(Class<?>[] sources, String... props) {
        String[] all = new String[props.length + 3];
        System.arraycopy(props, 0, all, 0, props.length);
        all[props.length] = "server.port=0";
        all[props.length + 1] = "pso.service.name=users-service";
        all[props.length + 2] = "logging.level.root=OFF";
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(sources).properties(all).run()) {
            throw new AssertionError("the application was expected to refuse to start");
        } catch (AssertionError e) {
            throw e;
        } catch (Throwable t) {
            StringBuilder sb = new StringBuilder();
            for (Throwable c = t; c != null; c = c.getCause()) {
                sb.append(c.getMessage()).append('\n');
            }
            return sb.toString();
        }
    }

    @Test
    void h2CannotLeakIntoProductionOrStaging() {
        assertThat(failure(new Class<?>[] {TestApp.class}, "pso.database.provider=h2", "spring.profiles.active=prod")).contains("not allowed with the \"prod\" profile");
        assertThat(failure(new Class<?>[] {TestApp.class}, "pso.database.provider=h2", "spring.profiles.active=staging")).contains("not allowed with the \"staging\" profile");
    }

    @Test
    void anUnknownDatabaseProviderIsRejected() {
        assertThat(failure(new Class<?>[] {TestApp.class}, "pso.database.provider=oracle")).contains("provider");
    }
}
