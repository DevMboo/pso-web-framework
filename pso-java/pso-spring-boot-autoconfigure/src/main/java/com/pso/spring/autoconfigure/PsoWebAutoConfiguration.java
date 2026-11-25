package com.pso.spring.autoconfigure;

import com.pso.spring.autoconfigure.web.BodySizeLimitFilter;
import com.pso.spring.autoconfigure.web.ConcurrencyLimitFilter;
import com.pso.spring.autoconfigure.web.CorrelationIdFilter;
import com.pso.spring.autoconfigure.ratelimit.ClientRateLimitFilter;
import com.pso.spring.autoconfigure.ratelimit.LocalPolicyRateLimiter;
import com.pso.spring.autoconfigure.ratelimit.PolicyRateLimiter;
import com.pso.spring.autoconfigure.ratelimit.PrincipalRateLimitInterceptor;
import com.pso.spring.autoconfigure.ratelimit.RateLimitSettings;
import com.pso.spring.autoconfigure.web.RateLimitFilter;
import java.util.ArrayList;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * Servlet-stack behavior: ONE authoritative endpoint prefix, request limits and correlation. The prefix is applied here, once,
 * to {@code @RestController} classes. Controllers map paths without it; the orchestrator adds it when forwarding.
 */
@AutoConfiguration(after = PsoAutoConfiguration.class)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class PsoWebAutoConfiguration {

    @Bean
    WebMvcConfigurer psoPrefixConfigurer(PsoServiceInfo info) {
        return new WebMvcConfigurer() {
            @Override
            public void configurePathMatch(PathMatchConfigurer configurer) {
                if (!info.prefix().isEmpty()) {
                    configurer.addPathPrefix(info.prefix(), type ->
                        type.isAnnotationPresent(RestController.class)
                            && !type.isAnnotationPresent(Unprefixed.class)
                            && !type.getName().startsWith("org.springframework."));
                }
            }
        };
    }

    /** Fails start-up when the prefix would be applied twice (context path, or a controller that already contains it). */
    @Bean
    SmartInitializingSingleton psoPrefixValidator(PsoServiceInfo info, Environment env, @org.springframework.beans.factory.annotation.Qualifier("requestMappingHandlerMapping") ObjectProvider<RequestMappingHandlerMapping> mappings) {
        return () -> {
            String ctx = env.getProperty("server.servlet.context-path", "");
            if (!info.prefix().isEmpty() && !ctx.isBlank() && !ctx.equals("/")) {
                throw new IllegalStateException("server.servlet.context-path=" + ctx + " together with pso.service.prefix=" + info.prefix()
                    + " would duplicate the prefix. Keep the context path empty: PSO applies the prefix (set pso.service.prefix to \"/\" to disable it).");
            }
            RequestMappingHandlerMapping mapping = mappings.getIfAvailable();
            if (mapping == null || info.prefix().isEmpty()) {
                return;
            }
            String twice = info.prefix() + info.prefix();
            List<String> offenders = new ArrayList<>();
            for (java.util.Map.Entry<RequestMappingInfo, org.springframework.web.method.HandlerMethod> entry : mapping.getHandlerMethods().entrySet()) {
                RequestMappingInfo m = entry.getKey();
                // a controller that declares the repetition (@RepeatsServicePrefix) asked for it: /orders/orders is its address
                if (org.springframework.core.annotation.AnnotatedElementUtils.hasAnnotation(entry.getValue().getBeanType(), RepeatsServicePrefix.class)) {
                    continue;
                }
                for (String p : m.getPathPatternsCondition() == null ? java.util.Set.<String>of() : m.getPathPatternsCondition().getPatternValues()) {
                    if (p.equals(twice) || p.startsWith(twice + "/")) {
                        offenders.add(p);
                    }
                }
            }
            if (!offenders.isEmpty()) {
                throw new IllegalStateException("The service prefix " + info.prefix() + " is applied automatically but these mappings already contain it: "
                    + offenders + ". Remove the prefix from the controller mapping. If the path is intended (a resource named like the service), declare it on the controller with @RepeatsServicePrefix.");
            }
        };
    }

    @Bean
    @ConditionalOnProperty(prefix = "pso.observability.correlation", name = "enabled", havingValue = "true", matchIfMissing = true)
    FilterRegistrationBean<CorrelationIdFilter> psoCorrelationFilter(PsoProperties props) {
        FilterRegistrationBean<CorrelationIdFilter> reg = new FilterRegistrationBean<>(new CorrelationIdFilter(props.getObservability().getCorrelation().getHeader()));
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return reg;
    }

    @Bean
    @ConditionalOnProperty(prefix = "pso.limits.concurrency", name = "max-requests")
    FilterRegistrationBean<ConcurrencyLimitFilter> psoConcurrencyFilter(PsoProperties props) {
        int max = props.getLimits().getConcurrency().getMaxRequests();
        FilterRegistrationBean<ConcurrencyLimitFilter> reg = new FilterRegistrationBean<>(new ConcurrencyLimitFilter(Math.max(1, max)));
        reg.setEnabled(max > 0);
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 10);
        return reg;
    }

    // ---- rate limiting -------------------------------------------------------------------------------------------------------
    // Stage 1 (filter, before authentication): one budget per client address. Stage 2 (interceptor, after authentication): a budget per
    // principal and the route-specific policies. A custom legacy RateLimiter bean still replaces stage 1 as before.

    @Bean
    RateLimitSettings psoRateLimitSettings(PsoProperties props) {
        return RateLimitSettings.from(props.getLimits().getRequests());
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnMissingBean(PolicyRateLimiter.class)
    PolicyRateLimiter psoPolicyRateLimiter(PsoProperties props, RateLimitSettings settings) {
        if (props.getLimits().getRequests().getProvider().equals("redis")) {
            throw new IllegalStateException("pso.limits.requests.provider=redis but no Redis rate limit provider is on the classpath. Add the artifact com.pso:pso-ratelimit-redis-starter");
        }
        return new LocalPolicyRateLimiter(settings.maxKeys());
    }

    @Bean
    @ConditionalOnMissingBean(RateLimiter.class)
    @ConditionalOnProperty(prefix = "pso.limits.requests", name = "enabled", havingValue = "true", matchIfMissing = true)
    FilterRegistrationBean<ClientRateLimitFilter> psoRateLimitFilter(PolicyRateLimiter limiter, RateLimitSettings settings) {
        FilterRegistrationBean<ClientRateLimitFilter> reg = new FilterRegistrationBean<>(new ClientRateLimitFilter(limiter, settings));
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 20);
        return reg;
    }

    /** Compatibility: an application-defined RateLimiter keeps working exactly as before (per remote address, no principal or route stage). */
    @Bean
    @ConditionalOnBean(RateLimiter.class)
    @ConditionalOnProperty(prefix = "pso.limits.requests", name = "enabled", havingValue = "true", matchIfMissing = true)
    FilterRegistrationBean<RateLimitFilter> psoLegacyRateLimitFilter(RateLimiter limiter) {
        FilterRegistrationBean<RateLimitFilter> reg = new FilterRegistrationBean<>(new RateLimitFilter(limiter));
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 20);
        return reg;
    }

    @Bean
    @ConditionalOnMissingBean(RateLimiter.class)
    WebMvcConfigurer psoRateLimitInterceptor(PolicyRateLimiter limiter, RateLimitSettings settings, PsoServiceInfo info) {
        return new WebMvcConfigurer() {
            @Override
            public void addInterceptors(org.springframework.web.servlet.config.annotation.InterceptorRegistry registry) {
                if (settings.enabled() || !settings.routes().isEmpty()) {
                    registry.addInterceptor(new PrincipalRateLimitInterceptor(limiter, settings, info.prefix()));
                }
            }
        };
    }

    @Bean
    @org.springframework.boot.autoconfigure.condition.ConditionalOnClass(name = "io.micrometer.core.instrument.MeterRegistry")
    org.springframework.beans.factory.SmartInitializingSingleton psoRateLimitMetrics(PolicyRateLimiter limiter, ObjectProvider<io.micrometer.core.instrument.MeterRegistry> registry) {
        return () -> registry.ifAvailable(r -> {
            for (String result : new String[] {"allowed", "denied", "backend_failure"}) {
                io.micrometer.core.instrument.FunctionCounter.builder("pso.ratelimit.decisions", limiter, l -> switch (result) {
                    case "allowed" -> l.stats().allowed();
                    case "denied" -> l.stats().denied();
                    default -> l.stats().backendFailures();
                }).tag("result", result).description("PSO rate limit decisions").register(r);
            }
        });
    }

    @Bean
    FilterRegistrationBean<BodySizeLimitFilter> psoBodySizeFilter(PsoProperties props) {
        PsoProperties.Limits l = props.getLimits();
        FilterRegistrationBean<BodySizeLimitFilter> reg = new FilterRegistrationBean<>(
            new BodySizeLimitFilter(l.getBody().getMaxSize().toBytes(), l.getMultipart().getMaxRequestSize().toBytes(), l.getMultipart().isEnabled()));
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 30);
        return reg;
    }
}
