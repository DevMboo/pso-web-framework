package com.pso.spring.security;

import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.security.oauth2.resource.servlet.OAuth2ResourceServerAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationManager;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter;
import org.springframework.security.web.access.intercept.RequestAuthorizationContext;
import org.springframework.web.cors.CorsConfigurationSource;

/**
 * First-party security: a stateless JWT resource server driven by {@code pso.security.*}. Deny by default: only the health
 * probes (configurable) and rules you list explicitly are reachable without authentication; everything else needs a valid token.
 * The application can replace any part: a {@code SecurityFilterChain} or {@code JwtDecoder} bean of its own makes this back off.
 */
@AutoConfiguration(
    after = PsoAutoConfiguration.class,
    before = {SecurityAutoConfiguration.class, UserDetailsServiceAutoConfiguration.class, OAuth2ResourceServerAutoConfiguration.class})
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnClass({SecurityFilterChain.class, JwtDecoder.class})
@ConditionalOnProperty(prefix = "pso.security", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableMethodSecurity
public class PsoSecurityAutoConfiguration {

    /** Method-security failures raised inside controllers become 401/403 problems. */
    @Bean
    @org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean(PsoSecurityProblemAdvice.class)
    PsoSecurityProblemAdvice psoSecurityProblemAdvice() {
        return new PsoSecurityProblemAdvice();
    }

    private static final Logger log = LoggerFactory.getLogger(PsoSecurityAutoConfiguration.class);
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9:._/-]{1,100}$");

    @Bean
    @ConditionalOnMissingBean(JwtDecoder.class)
    JwtDecoder psoJwtDecoder(PsoProperties props, Environment env) {
        PsoProperties.Jwt jwt = props.getSecurity().getJwt();
        if (jwt.isBlank()) {
            for (String p : env.getActiveProfiles()) {
                if (p.equals("prod") || p.equals("staging")) {
                    throw new IllegalStateException("pso.security.jwt.* (jwks-uri, issuer, audience) must be configured in the \"" + p
                        + "\" profile. Set PSO_JWT_JWKS_URI, PSO_JWT_ISSUER and PSO_JWT_AUDIENCE.");
                }
            }
            log.warn("JWT validation is not configured (pso.security.jwt.*): every bearer token is rejected. This is the safe default for local work.");
            return PsoJwtDecoderFactory.rejectAll();
        }
        return PsoJwtDecoderFactory.create(jwt);
    }

    @Bean
    @ConditionalOnMissingBean(name = "psoJwtAuthenticationConverter")
    JwtAuthenticationConverter psoJwtAuthenticationConverter(PsoProperties props) {
        // scope AND scp -> SCOPE_*. Spring's default converter reads only the FIRST claim it finds (scope before scp), so a provider that keeps
        // the OIDC scopes ("openid profile") in `scope` and the user's permissions in `scp` (Keycloak role mapper, Azure AD) would lose them.
        JwtGrantedAuthoritiesConverter byScope = new JwtGrantedAuthoritiesConverter();
        byScope.setAuthoritiesClaimName("scope");
        JwtGrantedAuthoritiesConverter byScp = new JwtGrantedAuthoritiesConverter();
        byScp.setAuthoritiesClaimName("scp");
        String rolesClaim = props.getSecurity().getJwt().getRolesClaim();
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(jwt -> {
            Set<GrantedAuthority> out = new LinkedHashSet<>();
            java.util.Collection<GrantedAuthority> fromScope = byScope.convert(jwt);
            java.util.Collection<GrantedAuthority> fromScp = byScp.convert(jwt);
            if (fromScope != null) out.addAll(fromScope);
            if (fromScp != null) out.addAll(fromScp);
            for (String role : rolesOf(jwt, rolesClaim)) {
                if (NAME.matcher(role).matches()) {
                    out.add(new SimpleGrantedAuthority("ROLE_" + role));
                }
            }
            return out;
        });
        return converter;
    }

    @Bean
    @ConditionalOnMissingBean(name = "corsConfigurationSource")
    @ConditionalOnProperty(prefix = "pso.security.cors", name = "enabled", havingValue = "true")
    CorsConfigurationSource corsConfigurationSource(PsoProperties props) {
        return PsoCorsPolicy.build(props.getSecurity().getCors());
    }

    @Bean
    @ConditionalOnMissingBean(SecurityFilterChain.class)
    SecurityFilterChain psoSecurityFilterChain(HttpSecurity http, PsoProperties props, PsoServiceInfo info, JwtAuthenticationConverter converter,
                                               @org.springframework.beans.factory.annotation.Qualifier("corsConfigurationSource") ObjectProvider<CorsConfigurationSource> cors) throws Exception {
        PsoProperties.Security sec = props.getSecurity();
        validateRules(sec.getRules());
        http
            .csrf(AbstractHttpConfigurer::disable) // stateless API: bearer tokens only, no cookies or sessions, so there is nothing to forge
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .httpBasic(AbstractHttpConfigurer::disable)
            .formLogin(AbstractHttpConfigurer::disable)
            .logout(AbstractHttpConfigurer::disable);
        CorsConfigurationSource source = cors.getIfAvailable();
        if (source != null) {
            http.cors(c -> c.configurationSource(source));
        } else {
            http.cors(AbstractHttpConfigurer::disable);
        }
        if (sec.getHeaders().isEnabled()) {
            ReferrerPolicyHeaderWriter.ReferrerPolicy policy = referrerPolicy(sec.getHeaders().getReferrerPolicy());
            http.headers(h -> h.referrerPolicy(r -> r.policy(policy)));
        }
        http.authorizeHttpRequests(a -> {
            // error pages are rendered by a second (ERROR) dispatch; without this, a 404/400 on a permitted path would become a 401
            a.dispatcherTypeMatchers(jakarta.servlet.DispatcherType.ERROR).permitAll();
            if (sec.getActuator().isHealthPublic()) {
                a.requestMatchers("/actuator/health", "/actuator/health/**").permitAll();
            }
            for (PsoProperties.Rule rule : sec.getRules()) {
                String pattern = info.prefix() + rule.getPath();
                List<String> methods = rule.getMethods();
                String[] patterns = {pattern};
                if (methods.isEmpty()) {
                    apply(a.requestMatchers(patterns), rule);
                } else {
                    for (String m : methods) {
                        apply(a.requestMatchers(HttpMethod.valueOf(m.toUpperCase()), patterns), rule);
                    }
                }
            }
            a.anyRequest().authenticated();
        });
        // an invalid or expired token is rejected by the resource server's own entry point: it must speak the PSO error standard too
        http.oauth2ResourceServer(o -> o.jwt(j -> j.jwtAuthenticationConverter(converter))
            .authenticationEntryPoint((req, res, ex) -> com.pso.spring.autoconfigure.problem.Problems.write(req, res, "unauthorized",
                ex instanceof org.springframework.security.oauth2.core.OAuth2AuthenticationException ? "Bearer error=\"invalid_token\"" : "Bearer"))
            .accessDeniedHandler((req, res, ex) -> com.pso.spring.autoconfigure.problem.Problems.write(req, res, "forbidden")));
        http.exceptionHandling(e -> e
            .authenticationEntryPoint((req, res, ex) -> com.pso.spring.autoconfigure.problem.Problems.write(req, res, "unauthorized"))
            .accessDeniedHandler((req, res, ex) -> com.pso.spring.autoconfigure.problem.Problems.write(req, res, "forbidden")));
        return http.build();
    }

    // ------------------------------------------------------------------ helpers

    private static void apply(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer<HttpSecurity>.AuthorizedUrl url, PsoProperties.Rule rule) {
        switch (rule.getAccess()) {
            case PUBLIC -> url.permitAll();
            case AUTHENTICATED -> url.authenticated();
            case SCOPES -> url.access(scopesAndRoles(rule.getScopes(), rule.getRoles()));
        }
    }

    /** All listed scopes AND (when roles are listed) at least one of the roles; anonymous callers never pass. */
    static AuthorizationManager<RequestAuthorizationContext> scopesAndRoles(List<String> scopes, List<String> roles) {
        return (auth, ctx) -> {
            Authentication a = auth.get();
            if (a == null || !a.isAuthenticated() || a instanceof AnonymousAuthenticationToken) {
                return new AuthorizationDecision(false);
            }
            Set<String> have = new LinkedHashSet<>();
            for (GrantedAuthority g : a.getAuthorities()) {
                have.add(g.getAuthority());
            }
            boolean scopesOk = scopes.stream().allMatch(s -> have.contains("SCOPE_" + s));
            boolean rolesOk = roles.isEmpty() || roles.stream().anyMatch(r -> have.contains("ROLE_" + r));
            return new AuthorizationDecision(scopesOk && rolesOk);
        };
    }

    static void validateRules(List<PsoProperties.Rule> rules) {
        List<String> problems = new ArrayList<>();
        int i = 0;
        for (PsoProperties.Rule r : rules) {
            String at = "pso.security.rules[" + i++ + "]";
            if (r.getPath() == null || !r.getPath().startsWith("/")) {
                problems.add(at + ".path must start with / and is relative to the service prefix");
            }
            for (String m : r.getMethods()) {
                try {
                    HttpMethod.valueOf(m.toUpperCase());
                } catch (IllegalArgumentException e) {
                    problems.add(at + ".methods: unknown method " + m);
                }
            }
            for (String s : concat(r.getScopes(), r.getRoles())) {
                if (!NAME.matcher(s).matches()) {
                    problems.add(at + ": invalid scope or role name \"" + s + "\"");
                }
            }
            if (r.getAccess() == PsoProperties.Access.SCOPES && r.getScopes().isEmpty() && r.getRoles().isEmpty()) {
                problems.add(at + ": access SCOPES needs scopes or roles");
            }
            if (r.getAccess() == PsoProperties.Access.PUBLIC && (!r.getScopes().isEmpty() || !r.getRoles().isEmpty())) {
                problems.add(at + ": a PUBLIC rule cannot also require scopes or roles");
            }
            if (r.getAccess() != PsoProperties.Access.SCOPES && (!r.getScopes().isEmpty() || !r.getRoles().isEmpty())) {
                problems.add(at + ": scopes and roles are only used with access SCOPES");
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Invalid pso.security.rules:\n - " + String.join("\n - ", problems));
        }
    }

    private static List<String> concat(List<String> a, List<String> b) {
        List<String> out = new ArrayList<>(a);
        out.addAll(b);
        return out;
    }

    private static ReferrerPolicyHeaderWriter.ReferrerPolicy referrerPolicy(String value) {
        try {
            return ReferrerPolicyHeaderWriter.ReferrerPolicy.valueOf(value.trim().toUpperCase().replace('-', '_'));
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("pso.security.headers.referrer-policy: unknown policy \"" + value + "\"");
        }
    }

    /** Reads a claim by dotted path; accepts a collection or a space/comma separated string. */
    @SuppressWarnings("unchecked")
    static List<String> rolesOf(Jwt jwt, String path) {
        Object cur = jwt.getClaims();
        for (String part : path.split("\\.")) {
            if (cur instanceof Map<?, ?> m) {
                cur = ((Map<String, Object>) m).get(part);
            } else {
                return List.of();
            }
        }
        List<String> out = new ArrayList<>();
        if (cur instanceof Collection<?> c) {
            for (Object o : c) {
                if (o instanceof String s) {
                    out.add(s);
                }
            }
        } else if (cur instanceof String s) {
            for (String p : s.split("[\\s,]+")) {
                if (!p.isBlank()) {
                    out.add(p);
                }
            }
        }
        return out;
    }
}
