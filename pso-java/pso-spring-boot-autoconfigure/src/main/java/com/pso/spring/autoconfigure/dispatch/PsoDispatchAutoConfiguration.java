package com.pso.spring.autoconfigure.dispatch;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.Envelope;
import com.pso.dispatch.Events;
import com.pso.dispatch.IdempotencyStore;
import com.pso.dispatch.PsoDispatch;
import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

/**
 * PSO Dispatch for Spring Boot. With {@code pso.dispatch.enabled=false} (the default) the only bean is a {@link PsoDispatch.Disabled}
 * that fails clearly on use: no broker is contacted, no consumer starts, no topology is created. Enabling requires BOTH the property
 * and an installed provider starter; any inconsistency stops start-up.
 */
@AutoConfiguration(after = PsoAutoConfiguration.class)
@ConditionalOnClass(DispatchRuntime.class)
public class PsoDispatchAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(PsoDispatch.class)
    @ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "false", matchIfMissing = true)
    PsoDispatch psoDispatchDisabled() {
        return new PsoDispatch.Disabled();
    }

    /**
     * With dispatch disabled an injected {@link Outbox} is a placeholder that refuses to store events (see {@link Outbox#disabled()}),
     * so a service that uses the outbox still starts in the environments where dispatch is off. With dispatch ENABLED there is no
     * placeholder: code that needs the outbox while {@code pso.dispatch.outbox.enabled} is false fails at start-up, as before.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "false", matchIfMissing = true)
    // only where the outbox can exist at all: a service without JDBC cannot inject Outbox, and must not load the class
    @ConditionalOnClass(name = {"org.springframework.jdbc.core.JdbcTemplate", "org.springframework.transaction.support.TransactionTemplate"})
    static class DisabledOutbox {
        @Bean
        @ConditionalOnMissingBean(Outbox.class)
        Outbox psoOutboxDisabled() {
            return Outbox.disabled();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "pso.dispatch", name = "enabled", havingValue = "true")
    static class Enabled {

        @Bean
        @ConditionalOnMissingBean
        Events.Registry psoEventRegistry(ObjectProvider<ObjectMapper> mapper) throws IOException {
            ObjectMapper m = mapper.getIfAvailable(() -> new ObjectMapper().findAndRegisterModules());
            PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
            Events.Registry registry = new Events.Registry();
            List<String> problems = new ArrayList<>();
            for (Resource r : resolver.getResources("classpath*:dispatch/*.events.json")) {
                JsonNode root = m.readTree(r.getInputStream());
                JsonNode events = root.get("events");
                if (events == null || !events.isArray()) {
                    problems.add(r.getFilename() + ": expected { \"events\": [...] }");
                    continue;
                }
                for (JsonNode e : events) {
                    JsonNode schema = e.get("schema");
                    if (schema != null && schema.isTextual()) {
                        Resource sr = resolver.getResource("classpath:dispatch/" + schema.asText());
                        if (!sr.exists()) {
                            problems.add(r.getFilename() + ": schema file " + schema.asText() + " of \"" + e.path("name").asText() + "\" does not exist");
                            continue;
                        }
                        schema = m.readTree(sr.getInputStream());
                    }
                    List<Integer> accepts = new ArrayList<>();
                    if (e.has("accepts")) {
                        e.get("accepts").forEach(x -> accepts.add(x.asInt()));
                    }
                    try {
                        registry.add(new Events.Decl(e.path("name").asText(), e.path("version").asInt(0), e.path("channel").asText(), schema,
                            e.has("compatibility") ? e.get("compatibility").asText() : "full", accepts, !e.has("publish") || e.get("publish").asBoolean(true),
                            e.has("key") ? e.get("key").asText() : null));
                    } catch (RuntimeException ex) {
                        problems.add(r.getFilename() + ": " + ex.getMessage());
                    }
                }
            }
            if (!problems.isEmpty()) {
                throw new IllegalStateException("Invalid dispatch declarations; nothing was started:\n - " + String.join("\n - ", problems));
            }
            return registry;
        }

        @Bean
        @ConditionalOnMissingBean
        IdempotencyStore psoIdempotencyStore() {
            return new IdempotencyStore.Memory();
        }

        @Bean(destroyMethod = "")
        @ConditionalOnMissingBean(PsoDispatch.class)
        DispatchRuntime psoDispatchRuntime(PsoProperties props, PsoServiceInfo service, ObjectProvider<DispatchAdapter> adapters, Events.Registry registry,
                                           IdempotencyStore idempotency, ObjectProvider<ObjectMapper> mapper, org.springframework.core.env.Environment environment) {
            PsoProperties.Dispatch d = props.getDispatch();
            // the in-process adapter is a test tool: events would be lost with the process, and no other service would ever see them
            if (d.getProvider().equals("memory") && isProduction(environment)) {
                throw new IllegalStateException("pso.dispatch.provider=memory is the in-process test adapter (com.pso:pso-dispatch-test): it is not durable, "
                    + "reaches no other service and is never allowed in production. Set the provider of the broker this service uses (redis, rabbitmq or kafka)");
            }
            String problem = productionTrustProblem(d.getTrust().getMode(), isProduction(environment), d.isAllowUnauthenticated());
            if (problem != null) {
                throw new IllegalStateException(problem);
            }
            if (isProduction(environment) && "off".equalsIgnoreCase(d.getTrust().getMode())) {
                org.slf4j.LoggerFactory.getLogger(PsoDispatchAutoConfiguration.class).warn("INSECURE legacy mode (pso.dispatch.allow-unauthenticated / PSO_DISPATCH_ALLOW_UNAUTHENTICATED): dispatch does not authenticate publishers; "
                    + "the source of a consumed event is whatever its producer wrote. Configure pso.dispatch.signing-key, the publishers' keys and pso.dispatch.trust.mode=required, then remove the setting");
            }
            if (d.getProvider().equals("none")) {
                throw new IllegalStateException("pso.dispatch.enabled=true requires pso.dispatch.provider (redis, rabbitmq or kafka). Install one with: pso dispatch:install <provider>");
            }
            DispatchAdapter adapter = adapters.getIfAvailable();
            if (adapter == null) {
                throw new IllegalStateException("pso.dispatch.provider=" + d.getProvider() + " but no dispatch provider starter is on the classpath. Install it with: pso dispatch:install " + d.getProvider());
            }
            if (!adapter.capabilities().provider().equals(d.getProvider())) {
                throw new IllegalStateException("pso.dispatch.provider=" + d.getProvider() + " but the installed provider is \"" + adapter.capabilities().provider() + "\"");
            }
            if (registry.all().isEmpty()) {
                throw new IllegalStateException("pso.dispatch.enabled=true but no events are declared: add dispatch/<name>.events.json to the classpath resources");
            }
            PsoProperties.DispatchRetry r = d.getRetry();
            DispatchRuntime.Settings settings = new DispatchRuntime.Settings(service.name(), d.getConsumer().getConcurrency(), d.getConsumer().getBatchSize(), r.isEnabled(), r.getMaxAttempts(),
                r.getInitialDelay().toMillis(), r.getMaxDelay().toMillis(), r.getMultiplier(), d.getDeadLetter().isEnabled(), (int) Math.min(Envelope.MAX_BYTES * 16L, d.getMaxMessageSize().toBytes()),
                d.getIdempotency().getRetention().toMillis(), 10_000);
            if (r.getInitialDelay().compareTo(r.getMaxDelay()) > 0) {
                throw new IllegalStateException("pso.dispatch.retry.initial-delay must not exceed max-delay");
            }
            // stated at every start: with the in-memory store a redelivery after a restart, or to another instance, runs the handler again
            boolean memory = idempotency instanceof IdempotencyStore.Memory;
            org.slf4j.LoggerFactory.getLogger(PsoDispatchAutoConfiguration.class).info("dispatch idempotency store: {} ({}), retention {}", idempotency.getClass().getSimpleName(),
                memory ? "per process: not durable, not shared between instances; handlers must be idempotent" : "provided by the application or the provider starter", d.getIdempotency().getRetention());
            return new DispatchRuntime(settings, adapter, registry, idempotency, mapper.getIfAvailable(() -> new ObjectMapper().findAndRegisterModules()), trust(d))
                .idempotencyLease(d.getIdempotency().getLease());
        }

        /** Production is what the Node runtime calls production (PSO_ENV=production) or a Spring profile named prod / production (the generated images set prod). */
        static boolean isProduction(org.springframework.core.env.Environment environment) {
            if ("production".equals(environment.getProperty("PSO_ENV"))) {
                return true;
            }
            for (String p : environment.getActiveProfiles()) {
                if (p.equals("prod") || p.equals("production")) {
                    return true;
                }
            }
            return false;
        }

        /**
         * The same rule as the Node runtime: in production an unauthenticated Dispatch (trust mode off) is refused at start-up unless
         * it was declared with pso.dispatch.allow-unauthenticated=true (PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true). Returns the problem
         * to report, or null. The declaration keeps a legacy installation running; it verifies nothing.
         */
        public static String productionTrustProblem(String mode, boolean production, boolean allowUnauthenticated) {
            if (!production || !"off".equalsIgnoreCase(mode) || allowUnauthenticated) {
                return null;
            }
            return "production requires publisher authentication: set pso.dispatch.trust.mode to \"required\" (or \"permissive\" while migrating) with pso.dispatch.signing-key "
                + "(PSO_DISPATCH_SIGNING_KEY) on publishers and PSO_DISPATCH_TRUST_KEY_<SERVICE> on consumers. To keep a legacy installation running unauthenticated, set "
                + "PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true (insecure, reported at every start)";
        }

        /** Publisher trust: the mode and keys of pso.dispatch.*, plus PSO_DISPATCH_TRUST_KEY_<SERVICE> variables (the Node runtime's names). */
        private static com.pso.dispatch.Trust trust(PsoProperties.Dispatch d) {
            java.util.Map<String, List<String>> keys = new java.util.LinkedHashMap<>(com.pso.dispatch.Trust.keysFromEnvironment(System.getenv()));
            d.getTrust().getKeys().forEach((service, value) -> {
                List<String> list = new ArrayList<>(keys.getOrDefault(service, List.of()));
                for (String k : value.split(",")) {
                    if (!k.isBlank()) {
                        list.add(k.trim());
                    }
                }
                keys.put(service, list);
            });
            com.pso.dispatch.Trust t;
            try {
                t = new com.pso.dispatch.Trust(com.pso.dispatch.Trust.Mode.of(d.getTrust().getMode()), d.getSigningKey(), keys);
            } catch (IllegalArgumentException e) {
                throw new IllegalStateException("Invalid dispatch trust configuration: " + e.getMessage());
            }
            org.slf4j.LoggerFactory.getLogger(PsoDispatchAutoConfiguration.class).info("dispatch publisher trust: mode={} signing={} verifiedSources={}",
                t.mode().name().toLowerCase(), t.signingKey() != null, new java.util.TreeSet<>(t.keys().keySet()));
            return t;
        }

        /** The optional transactional outbox: needs a JDBC database; consumer-only services never need one. */
        @Bean
        @ConditionalOnProperty(prefix = "pso.dispatch.outbox", name = "enabled", havingValue = "true")
        Outbox psoOutbox(DispatchRuntime runtime, PsoProperties props, ObjectProvider<org.springframework.jdbc.core.JdbcTemplate> jdbc,
                         ObjectProvider<org.springframework.transaction.PlatformTransactionManager> tx) {
            org.springframework.jdbc.core.JdbcTemplate template = jdbc.getIfAvailable();
            org.springframework.transaction.PlatformTransactionManager manager = tx.getIfAvailable();
            if (template == null || manager == null) {
                throw new IllegalStateException("pso.dispatch.outbox.enabled=true needs a JDBC database and a transaction manager: run `pso database:enable postgresql` and `pso dispatch:outbox`");
            }
            PsoProperties.DispatchOutbox o = props.getDispatch().getOutbox();
            return new Outbox(runtime, template, new org.springframework.transaction.support.TransactionTemplate(manager),
                new Outbox.Config(o.getBatchSize(), o.getMaxAttempts(), o.getPollInterval(), o.getRetryBackoff(), o.getRetention()));
        }

        /** Dispatch and outbox counters as Micrometer meters (only when Micrometer is on the classpath). */
        @Bean
        @org.springframework.boot.autoconfigure.condition.ConditionalOnClass(name = "io.micrometer.core.instrument.binder.MeterBinder")
        PsoDispatchMetrics psoDispatchMetrics(DispatchRuntime runtime, ObjectProvider<Outbox> outbox) {
            return new PsoDispatchMetrics(runtime, outbox.getIfAvailable());
        }

        @Bean
        PsoEventHandlerRegistrar psoEventHandlerRegistrar(DispatchRuntime runtime, ApplicationContext ctx, ObjectProvider<ObjectMapper> mapper) {
            return new PsoEventHandlerRegistrar(runtime, ctx, mapper.getIfAvailable(() -> new ObjectMapper().findAndRegisterModules()));
        }
    }
}
