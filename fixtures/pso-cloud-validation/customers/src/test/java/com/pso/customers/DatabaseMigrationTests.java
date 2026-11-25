package com.pso.customers;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The database wiring of this service against a real PostgreSQL (see TestDatabaseConfig): the application context starts, the
 * data source answers and every Flyway migration under src/main/resources/db/migration was applied. A new service has no migration
 * yet; add the first one with {@code pso make:migration <name> --service customers}.
 */
@SpringBootTest
class DatabaseMigrationTests {

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    Flyway flyway;

    @Test
    void theDataSourceIsARealPostgreSql() {
        String product = jdbc.queryForObject("SELECT current_setting('server_version_num')", String.class);
        assertEquals(true, product != null && Integer.parseInt(product) >= 120000, "PostgreSQL 12 or newer");
    }

    @Test
    void everyMigrationWasApplied() {
        assertEquals(0, flyway.info().pending().length, "no pending Flyway migration");
    }
}
