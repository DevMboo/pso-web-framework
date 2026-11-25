package com.pso.customers;

import java.io.IOException;
import javax.sql.DataSource;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

/**
 * Tests run against a real PostgreSQL (embedded native binaries, no Docker needed), never against a mock.
 * Component scanning picks this class up for every @SpringBootTest in this module.
 */
@Configuration
class TestDatabaseConfig {

    @Bean(destroyMethod = "close")
    EmbeddedPostgres embeddedPostgres() throws IOException {
        return EmbeddedPostgres.builder().start();
    }

    @Bean
    @Primary
    DataSource dataSource(EmbeddedPostgres pg) {
        return pg.getPostgresDatabase();
    }
}
