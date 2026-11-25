package com.pso.spring.autoconfigure;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

/**
 * Typed {@code pso.*} configuration. Unknown keys are an error ({@code ignoreUnknownFields = false}): a misspelled security
 * property must never be silently ignored. Environment variables are not checked (Spring does not report unbound
 * variables), so deployment overrides such as {@code PSO_JWT_ISSUER} stay free-form.
 */
@Validated
@ConfigurationProperties(prefix = "pso", ignoreUnknownFields = false)
public class PsoProperties {

    @Valid private final Service service = new Service();
    @Valid private final Security security = new Security();
    @Valid private final Http http = new Http();
    @Valid private final Limits limits = new Limits();
    @Valid private final Dispatch dispatch = new Dispatch();
    @Valid private final Database database = new Database();
    @Valid private final Observability observability = new Observability();
    @Valid private final Storage storage = new Storage();
    @Valid private final Channels channels = new Channels();

    public Storage getStorage() { return storage; }
    public Channels getChannels() { return channels; }
    public Service getService() { return service; }
    public Security getSecurity() { return security; }
    public Http getHttp() { return http; }
    public Limits getLimits() { return limits; }
    public Dispatch getDispatch() { return dispatch; }
    public Database getDatabase() { return database; }
    public Observability getObservability() { return observability; }

    // ------------------------------------------------------------------ pso.service
    public static class Service {
        /** Logical service name; also the default source of the endpoint prefix. */
        @Pattern(regexp = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", message = "must be kebab-case, for example users-service")
        private String name;
        /** Endpoint prefix. Empty means: derive from the name (users-service becomes /users). */
        private String prefix;

        public String getName() { return name; }
        public void setName(String name) { this.name = name; }
        public String getPrefix() { return prefix; }
        public void setPrefix(String prefix) { this.prefix = prefix; }
    }

    // ------------------------------------------------------------------ pso.security
    public static class Security {
        /** When false the starter does not configure Spring Security at all (the application must). */
        private boolean enabled = true;
        @Valid private final Jwt jwt = new Jwt();
        @Valid private final Cors cors = new Cors();
        @Valid private final Headers headers = new Headers();
        @Valid private final Actuator actuator = new Actuator();
        /** Explicit authorization rules, evaluated in order, relative to the service prefix. Everything else requires authentication. */
        @Valid private List<Rule> rules = new ArrayList<>();

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public Jwt getJwt() { return jwt; }
        public Cors getCors() { return cors; }
        public Headers getHeaders() { return headers; }
        public Actuator getActuator() { return actuator; }
        public List<Rule> getRules() { return rules; }
        public void setRules(List<Rule> rules) { this.rules = rules == null ? new ArrayList<>() : rules; }
    }

    public static class Jwt {
        private String jwksUri;
        private String issuer;
        private String audience;
        /** Asymmetric algorithms only. */
        private List<String> algorithms = new ArrayList<>(List.of("ES256", "RS256"));
        private Duration clockSkew = Duration.ofSeconds(30);
        /** Claim (dotted path allowed) holding roles; they become ROLE_* authorities. */
        private String rolesClaim = "roles";
        /**
         * PEM file with the certificate authority that signed the JWKS endpoint's certificate (an identity provider with a private CA).
         * It is used for the JWKS request only, in addition to nothing: when set, only this authority is trusted for that request.
         * Certificate and host name verification are never disabled.
         */
        private String caFile;
        /**
         * Approval of an identity provider on a private network: exact {@code host:port} entries. Only the JWKS URI itself, over
         * https, on exactly that host and port is covered; every other private, link-local or reserved address stays refused.
         */
        private List<String> privateHosts = new ArrayList<>();

        public List<String> getPrivateHosts() { return privateHosts; }
        public void setPrivateHosts(List<String> v) { this.privateHosts = v == null ? new ArrayList<>() : v; }
        public String getCaFile() { return caFile; }
        public void setCaFile(String caFile) { this.caFile = caFile; }
        public String getJwksUri() { return jwksUri; }
        public void setJwksUri(String jwksUri) { this.jwksUri = jwksUri; }
        public String getIssuer() { return issuer; }
        public void setIssuer(String issuer) { this.issuer = issuer; }
        public String getAudience() { return audience; }
        public void setAudience(String audience) { this.audience = audience; }
        public List<String> getAlgorithms() { return algorithms; }
        public void setAlgorithms(List<String> algorithms) { this.algorithms = algorithms == null ? new ArrayList<>() : algorithms; }
        public Duration getClockSkew() { return clockSkew; }
        public void setClockSkew(Duration clockSkew) { this.clockSkew = clockSkew; }
        public String getRolesClaim() { return rolesClaim; }
        public void setRolesClaim(String rolesClaim) { this.rolesClaim = rolesClaim; }

        public boolean isBlank() {
            return isEmpty(jwksUri) && isEmpty(issuer) && isEmpty(audience);
        }
        private static boolean isEmpty(String s) { return s == null || s.isBlank(); }
    }

    public static class Cors {
        private boolean enabled = false;
        /** Exact origins: scheme://host[:port], no path, no wildcard. */
        private List<String> allowedOrigins = new ArrayList<>();
        /** Origin patterns with a wildcard subdomain, for example https://*.example.com. Never combined with credentials. */
        private List<String> allowedOriginPatterns = new ArrayList<>();
        private List<String> allowedMethods = new ArrayList<>(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        private List<String> allowedHeaders = new ArrayList<>(List.of("Authorization", "Content-Type", "X-Correlation-ID"));
        private List<String> exposedHeaders = new ArrayList<>();
        private boolean allowCredentials = false;
        private Duration maxAge = Duration.ofMinutes(30);

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public List<String> getAllowedOrigins() { return allowedOrigins; }
        public void setAllowedOrigins(List<String> v) { this.allowedOrigins = v == null ? new ArrayList<>() : v; }
        public List<String> getAllowedOriginPatterns() { return allowedOriginPatterns; }
        public void setAllowedOriginPatterns(List<String> v) { this.allowedOriginPatterns = v == null ? new ArrayList<>() : v; }
        public List<String> getAllowedMethods() { return allowedMethods; }
        public void setAllowedMethods(List<String> v) { this.allowedMethods = v == null ? new ArrayList<>() : v; }
        public List<String> getAllowedHeaders() { return allowedHeaders; }
        public void setAllowedHeaders(List<String> v) { this.allowedHeaders = v == null ? new ArrayList<>() : v; }
        public List<String> getExposedHeaders() { return exposedHeaders; }
        public void setExposedHeaders(List<String> v) { this.exposedHeaders = v == null ? new ArrayList<>() : v; }
        public boolean isAllowCredentials() { return allowCredentials; }
        public void setAllowCredentials(boolean v) { this.allowCredentials = v; }
        public Duration getMaxAge() { return maxAge; }
        public void setMaxAge(Duration maxAge) { this.maxAge = maxAge; }
    }

    public static class Headers {
        private boolean enabled = true;
        private String referrerPolicy = "no-referrer";
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public String getReferrerPolicy() { return referrerPolicy; }
        public void setReferrerPolicy(String referrerPolicy) { this.referrerPolicy = referrerPolicy; }
    }

    public static class Actuator {
        /** /actuator/health and its probes are public (orchestrators and platforms probe them). Everything else needs authentication. */
        private boolean healthPublic = true;
        public boolean isHealthPublic() { return healthPublic; }
        public void setHealthPublic(boolean healthPublic) { this.healthPublic = healthPublic; }
    }

    public enum Access { PUBLIC, AUTHENTICATED, SCOPES }

    public static class Rule {
        @NotBlank private String path;
        private List<String> methods = new ArrayList<>();
        @NotNull private Access access = Access.AUTHENTICATED;
        private List<String> scopes = new ArrayList<>();
        private List<String> roles = new ArrayList<>();

        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public List<String> getMethods() { return methods; }
        public void setMethods(List<String> methods) { this.methods = methods == null ? new ArrayList<>() : methods; }
        public Access getAccess() { return access; }
        public void setAccess(Access access) { this.access = access; }
        public List<String> getScopes() { return scopes; }
        public void setScopes(List<String> scopes) { this.scopes = scopes == null ? new ArrayList<>() : scopes; }
        public List<String> getRoles() { return roles; }
        public void setRoles(List<String> roles) { this.roles = roles == null ? new ArrayList<>() : roles; }
    }

    // ------------------------------------------------------------------ pso.http
    public static class Http {
        @Valid private final Client client = new Client();
        public Client getClient() { return client; }
    }

    public static class Client {
        /** Named remote services. The only destinations the PSO HTTP client will ever contact. */
        @Valid private Map<String, Remote> services = new LinkedHashMap<>();
        public Map<String, Remote> getServices() { return services; }
        public void setServices(Map<String, Remote> services) { this.services = services == null ? new LinkedHashMap<>() : services; }
    }

    public static class Remote {
        @NotBlank private String baseUrl;
        private Duration connectTimeout = Duration.ofSeconds(2);
        private Duration readTimeout = Duration.ofSeconds(5);
        private DataSize maxResponseSize = DataSize.ofMegabytes(2);
        /** Forward the CALLER's verified bearer token to this service. Off by default: tokens are never sent to unrelated services. */
        private boolean forwardBearer = false;
        /** When set, the caller's bearer token is forwarded only if the token's audience includes this value (audience-aware delegation). */
        private String audience;
        /** Plain http is refused for non-loopback hosts unless this is set explicitly. */
        private boolean allowInsecureHttp = false;
        @Valid private final Retry retry = new Retry();
        @Valid private final Tls tls = new Tls();

        public String getBaseUrl() { return baseUrl; }
        public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
        public Duration getConnectTimeout() { return connectTimeout; }
        public void setConnectTimeout(Duration v) { this.connectTimeout = v; }
        public Duration getReadTimeout() { return readTimeout; }
        public void setReadTimeout(Duration v) { this.readTimeout = v; }
        public DataSize getMaxResponseSize() { return maxResponseSize; }
        public void setMaxResponseSize(DataSize v) { this.maxResponseSize = v; }
        public String getAudience() { return audience; }
        public void setAudience(String audience) { this.audience = audience; }
        public boolean isForwardBearer() { return forwardBearer; }
        public void setForwardBearer(boolean v) { this.forwardBearer = v; }
        public boolean isAllowInsecureHttp() { return allowInsecureHttp; }
        public void setAllowInsecureHttp(boolean v) { this.allowInsecureHttp = v; }
        public Retry getRetry() { return retry; }
        public Tls getTls() { return tls; }
    }

    public static class Retry {
        /** Total attempts including the first one. 1 disables retries. */
        @Min(1) @Max(5) private int maxAttempts = 2;
        private Duration backoff = Duration.ofMillis(100);
        /** Non-idempotent requests (POST, PATCH) are retried only when this is true AND the request carries an Idempotency-Key. */
        private boolean retryNonIdempotent = false;
        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int v) { this.maxAttempts = v; }
        public Duration getBackoff() { return backoff; }
        public void setBackoff(Duration v) { this.backoff = v; }
        public boolean isRetryNonIdempotent() { return retryNonIdempotent; }
        public void setRetryNonIdempotent(boolean v) { this.retryNonIdempotent = v; }
    }

    public static class Tls {
        /**
         * PEM file with the certificate authorities to trust (one or more certificates): the same file the orchestrator uses as
         * PSO_UPSTREAM_&lt;NAME&gt;_TLS_CA_FILE and that {@code pso tls:init} writes as ca.pem. Use it OR trust-store, not both.
         * Without either the JVM trust store is used. Certificate validation is never disabled.
         */
        private String caFile;
        /** PEM client certificate (with its chain) for mutual TLS; needs key-file. Use it OR key-store, not both. */
        private String certFile;
        /** PEM private key of cert-file (RSA or EC). */
        private String keyFile;
        /** Password of an encrypted key-file. A secret: set it from the environment. */
        private String keyPassword;
        /** Trust store (PKCS12 or JKS) for private CAs: the alternative to ca-file. */
        private String trustStore;
        private String trustStorePassword;
        private String trustStoreType = "PKCS12";
        /** Client key store: setting it enables mutual TLS for this service. */
        private String keyStore;
        private String keyStorePassword;
        private String keyStoreType = "PKCS12";
        /** The service identity the server certificate must ALSO carry (DNS or IP subject alternative name), on top of the normal host name check. */
        private String serverName;

        public String getServerName() { return serverName; }
        public void setServerName(String v) { this.serverName = v; }
        public String getCaFile() { return caFile; }
        public void setCaFile(String v) { this.caFile = v; }
        public String getCertFile() { return certFile; }
        public void setCertFile(String v) { this.certFile = v; }
        public String getKeyFile() { return keyFile; }
        public void setKeyFile(String v) { this.keyFile = v; }
        public String getKeyPassword() { return keyPassword; }
        public void setKeyPassword(String v) { this.keyPassword = v; }
        public String getTrustStore() { return trustStore; }
        public void setTrustStore(String v) { this.trustStore = v; }
        public String getTrustStorePassword() { return trustStorePassword; }
        public void setTrustStorePassword(String v) { this.trustStorePassword = v; }
        public String getTrustStoreType() { return trustStoreType; }
        public void setTrustStoreType(String v) { this.trustStoreType = v; }
        public String getKeyStore() { return keyStore; }
        public void setKeyStore(String v) { this.keyStore = v; }
        public String getKeyStorePassword() { return keyStorePassword; }
        public void setKeyStorePassword(String v) { this.keyStorePassword = v; }
        public String getKeyStoreType() { return keyStoreType; }
        public void setKeyStoreType(String v) { this.keyStoreType = v; }
    }

    // ------------------------------------------------------------------ pso.channels
    /** Publishing to PSO Channels ({@code pso-channels-spring-boot-starter}). Off by default; needs PSO Dispatch (the transport to the orchestrator). */
    public static class Channels {
        private boolean enabled = false;
        /** The Dispatch event that carries channel events to the orchestrator (declare it in dispatch/*.events.json). */
        @jakarta.validation.constraints.Pattern(regexp = "^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$", message = "must be a dotted lower-case Dispatch event name") private String dispatchEvent = "channels.publish";
        /** Largest event payload accepted for publication (the orchestrator enforces its own message limit as well). */
        @NotNull private DataSize maxPayload = DataSize.ofKilobytes(32);
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
        public String getDispatchEvent() { return dispatchEvent; }
        public void setDispatchEvent(String v) { this.dispatchEvent = v; }
        public DataSize getMaxPayload() { return maxPayload; }
        public void setMaxPayload(DataSize v) { this.maxPayload = v; }
    }

    // ------------------------------------------------------------------ pso.storage
    public enum StorageProviderType { LOCAL, S3, AZURE }
    public enum StorageMetadataStore { PROVIDER, MEMORY }

    /**
     * File storage ({@code pso-storage-spring-boot-starter}). Absent {@code provider} means storage is off: nothing is configured, no
     * provider SDK is touched. Provider specific values are validated when the provider is selected, with a message naming the property.
     */
    public static class Storage {
        private StorageProviderType provider;
        @Valid private final StorageUpload upload = new StorageUpload();
        @Valid private final StorageDownload download = new StorageDownload();
        @Valid private final StorageSignedUrl signedUrl = new StorageSignedUrl();
        @Valid private final StorageScan scan = new StorageScan();
        @Valid private final StorageMetadata metadata = new StorageMetadata();
        @Valid private final StorageLocal local = new StorageLocal();
        @Valid private final StorageS3 s3 = new StorageS3();
        @Valid private final StorageAzure azure = new StorageAzure();
        public StorageProviderType getProvider() { return provider; }
        public void setProvider(StorageProviderType provider) { this.provider = provider; }
        public StorageUpload getUpload() { return upload; }
        public StorageDownload getDownload() { return download; }
        public StorageSignedUrl getSignedUrl() { return signedUrl; }
        public StorageScan getScan() { return scan; }
        public StorageMetadata getMetadata() { return metadata; }
        public StorageLocal getLocal() { return local; }
        public StorageS3 getS3() { return s3; }
        public StorageAzure getAzure() { return azure; }
    }

    public static class StorageUpload {
        /** Largest accepted file, enforced while the content streams. */
        @NotNull private DataSize maxSize = DataSize.ofMegabytes(10);
        /** Accepted content types ({@code application/pdf}, {@code image/*}); empty accepts any type (signatures of known formats are still verified). */
        private List<String> allowedContentTypes = new ArrayList<>();
        /** Accepted filename extensions ({@code .pdf}); empty accepts any. */
        private List<String> allowedExtensions = new ArrayList<>();
        /** Trust the declared type for listed types the framework cannot verify by signature. Off by default. */
        private boolean allowUnverifiedTypes = false;
        public DataSize getMaxSize() { return maxSize; }
        public void setMaxSize(DataSize v) { this.maxSize = v; }
        public List<String> getAllowedContentTypes() { return allowedContentTypes; }
        public void setAllowedContentTypes(List<String> v) { this.allowedContentTypes = v; }
        public List<String> getAllowedExtensions() { return allowedExtensions; }
        public void setAllowedExtensions(List<String> v) { this.allowedExtensions = v; }
        public boolean isAllowUnverifiedTypes() { return allowUnverifiedTypes; }
        public void setAllowUnverifiedTypes(boolean v) { this.allowUnverifiedTypes = v; }
    }

    public static class StorageDownload {
        /** Content types that may be shown inline by a browser. Everything else is always an attachment. */
        private List<String> inlineContentTypes = new ArrayList<>(List.of("image/png", "image/jpeg", "image/gif", "image/webp"));
        public List<String> getInlineContentTypes() { return inlineContentTypes; }
        public void setInlineContentTypes(List<String> v) { this.inlineContentTypes = v; }
    }

    public static class StorageSignedUrl {
        /** Short-lived provider URLs (S3 presigned, Azure SAS). Off unless explicitly enabled; local storage never has them. */
        private boolean enabled = false;
        @NotNull private Duration defaultTtl = Duration.ofMinutes(1);
        @NotNull private Duration maxTtl = Duration.ofMinutes(5);
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
        public Duration getDefaultTtl() { return defaultTtl; }
        public void setDefaultTtl(Duration v) { this.defaultTtl = v; }
        public Duration getMaxTtl() { return maxTtl; }
        public void setMaxTtl(Duration v) { this.maxTtl = v; }
    }

    public static class StorageScan {
        /** Refuse to start (and refuse uploads) unless a ContentScanner bean exists. The framework ships no scanning engine. */
        private boolean required = false;
        public boolean isRequired() { return required; }
        public void setRequired(boolean v) { this.required = v; }
    }

    public static class StorageMetadata {
        /** PROVIDER keeps a small JSON record next to each file (no database needed). MEMORY is for tests. A FileMetadataStore bean replaces both. */
        private StorageMetadataStore store = StorageMetadataStore.PROVIDER;
        public StorageMetadataStore getStore() { return store; }
        public void setStore(StorageMetadataStore v) { this.store = v; }
    }

    public static class StorageLocal {
        /** Storage root directory (created with owner-only permissions when absent). Required for the local provider. */
        private String root;
        public String getRoot() { return root; }
        public void setRoot(String v) { this.root = v; }
    }

    public static class StorageS3 {
        private String bucket;
        /** Key prefix inside the bucket, without leading slash. */
        private String prefix = "";
        private String region;
        /** Endpoint override for S3-compatible stores and emulators (MinIO, LocalStack). */
        private String endpoint;
        private boolean pathStyleAccess = false;
        public String getBucket() { return bucket; }
        public void setBucket(String v) { this.bucket = v; }
        public String getPrefix() { return prefix; }
        public void setPrefix(String v) { this.prefix = v; }
        public String getRegion() { return region; }
        public void setRegion(String v) { this.region = v; }
        public String getEndpoint() { return endpoint; }
        public void setEndpoint(String v) { this.endpoint = v; }
        public boolean isPathStyleAccess() { return pathStyleAccess; }
        public void setPathStyleAccess(boolean v) { this.pathStyleAccess = v; }
    }

    public static class StorageAzure {
        /** Blob service endpoint, e.g. https://account.blob.core.windows.net (authenticated with DefaultAzureCredential: managed identity, workload identity, developer login). */
        private String endpoint;
        private String container;
        private String prefix = "";
        /** Development only (Azurite). Refused in the prod and staging profiles. Never commit it: use an environment placeholder. */
        private String connectionString;
        @NotNull private Duration copyTimeout = Duration.ofMinutes(5);
        public String getEndpoint() { return endpoint; }
        public void setEndpoint(String v) { this.endpoint = v; }
        public String getContainer() { return container; }
        public void setContainer(String v) { this.container = v; }
        public String getPrefix() { return prefix; }
        public void setPrefix(String v) { this.prefix = v; }
        public String getConnectionString() { return connectionString; }
        public void setConnectionString(String v) { this.connectionString = v; }
        public Duration getCopyTimeout() { return copyTimeout; }
        public void setCopyTimeout(Duration v) { this.copyTimeout = v; }
    }

    // ------------------------------------------------------------------ pso.limits
    public static class Limits {
        @Valid private final Requests requests = new Requests();
        @Valid private final Body body = new Body();
        @Valid private final Multipart multipart = new Multipart();
        @Valid private final Header header = new Header();
        @Valid private final Timeouts timeouts = new Timeouts();
        @Valid private final Concurrency concurrency = new Concurrency();
        public Requests getRequests() { return requests; }
        public Body getBody() { return body; }
        public Multipart getMultipart() { return multipart; }
        public Header getHeader() { return header; }
        public Timeouts getTimeouts() { return timeouts; }
        public Concurrency getConcurrency() { return concurrency; }
    }

    public static class Requests {
        private boolean enabled = true;
        /** Per client address (token bucket refilled at this rate per minute). Application-level throttling is not DDoS protection. */
        @Min(1) private int perMinute = 600;
        /** Bucket size; defaults to perMinute. */
        @Min(1) private Integer burst;
        /** Also give every authenticated principal a budget of its own. */
        private boolean perPrincipal = true;
        /** local (default) or redis (needs pso-ratelimit-redis-starter; shares one budget between instances). */
        @NotNull private String provider = "local";
        /** What to do when the shared backend is down: closed (default, answers 503) or open. */
        @NotNull private String onFailure = "closed";
        @Min(100) private int maxKeys = 10_000;
        /** IPs or CIDR ranges whose X-Forwarded-For is trusted. Empty: the header is never read. */
        private List<String> trustedProxies = new ArrayList<>();
        /** Route-specific policies on top of the global one, e.g. { route: "POST /customers", limit: 10, window-seconds: 60, burst: 5 }. */
        private List<RouteLimit> routes = new ArrayList<>();
        /** Redis URL for provider=redis. A secret: set it from the environment, never in a committed file. */
        private String redisUrl;
        private String redisPrefix = "pso:rl:";
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public int getPerMinute() { return perMinute; }
        public void setPerMinute(int perMinute) { this.perMinute = perMinute; }
        public Integer getBurst() { return burst; }
        public void setBurst(Integer burst) { this.burst = burst; }
        public boolean isPerPrincipal() { return perPrincipal; }
        public void setPerPrincipal(boolean perPrincipal) { this.perPrincipal = perPrincipal; }
        public String getProvider() { return provider; }
        public void setProvider(String provider) { this.provider = provider; }
        public String getOnFailure() { return onFailure; }
        public void setOnFailure(String onFailure) { this.onFailure = onFailure; }
        public int getMaxKeys() { return maxKeys; }
        public void setMaxKeys(int maxKeys) { this.maxKeys = maxKeys; }
        public List<String> getTrustedProxies() { return trustedProxies; }
        public void setTrustedProxies(List<String> trustedProxies) { this.trustedProxies = trustedProxies; }
        public List<RouteLimit> getRoutes() { return routes; }
        public void setRoutes(List<RouteLimit> routes) { this.routes = routes; }
        public String getRedisUrl() { return redisUrl; }
        public void setRedisUrl(String redisUrl) { this.redisUrl = redisUrl; }
        public String getRedisPrefix() { return redisPrefix; }
        public void setRedisPrefix(String redisPrefix) { this.redisPrefix = redisPrefix; }
    }

    public static class RouteLimit {
        private String route;
        private int limit;
        private int windowSeconds = 60;
        private Integer burst;
        public String getRoute() { return route; }
        public void setRoute(String route) { this.route = route; }
        public int getLimit() { return limit; }
        public void setLimit(int limit) { this.limit = limit; }
        public int getWindowSeconds() { return windowSeconds; }
        public void setWindowSeconds(int windowSeconds) { this.windowSeconds = windowSeconds; }
        public Integer getBurst() { return burst; }
        public void setBurst(Integer burst) { this.burst = burst; }
    }

    public static class Body {
        @NotNull private DataSize maxSize = DataSize.ofMegabytes(2);
        public DataSize getMaxSize() { return maxSize; }
        public void setMaxSize(DataSize maxSize) { this.maxSize = maxSize; }
    }

    public static class Multipart {
        private boolean enabled = false;
        @NotNull private DataSize maxFileSize = DataSize.ofMegabytes(5);
        @NotNull private DataSize maxRequestSize = DataSize.ofMegabytes(10);
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public DataSize getMaxFileSize() { return maxFileSize; }
        public void setMaxFileSize(DataSize v) { this.maxFileSize = v; }
        public DataSize getMaxRequestSize() { return maxRequestSize; }
        public void setMaxRequestSize(DataSize v) { this.maxRequestSize = v; }
    }

    public static class Header {
        @NotNull private DataSize maxSize = DataSize.ofKilobytes(16);
        public DataSize getMaxSize() { return maxSize; }
        public void setMaxSize(DataSize maxSize) { this.maxSize = maxSize; }
    }

    public static class Timeouts {
        /** Time the container waits for a request to arrive (slow-client protection). */
        @NotNull private Duration connection = Duration.ofSeconds(10);
        /** Maximum time an asynchronous request may run. */
        @NotNull private Duration asyncRequest = Duration.ofSeconds(30);
        public Duration getConnection() { return connection; }
        public void setConnection(Duration v) { this.connection = v; }
        public Duration getAsyncRequest() { return asyncRequest; }
        public void setAsyncRequest(Duration v) { this.asyncRequest = v; }
    }

    public static class Concurrency {
        /** Maximum requests handled at once; excess requests get 503. 0 disables the limit. */
        @Min(0) private int maxRequests = 0;
        public int getMaxRequests() { return maxRequests; }
        public void setMaxRequests(int maxRequests) { this.maxRequests = maxRequests; }
    }

    // ------------------------------------------------------------------ pso.dispatch, pso.database, pso.observability
    public static class Dispatch {
        /** Nothing connects while this is false, even when a provider starter is on the classpath. */
        private boolean enabled = false;
        /**
         * none, or the key of an installed provider starter (redis, rabbitmq, kafka). {@code memory} is the in-process adapter of
         * com.pso:pso-dispatch-test for the tests of a service: it needs that test-scoped artifact and is refused in production.
         */
        @NotBlank @Pattern(regexp = "^(none|redis|rabbitmq|kafka|memory)$", message = "must be one of none, redis, rabbitmq, kafka (or memory, in tests only)") private String provider = "none";
        @NotNull private DataSize maxMessageSize = DataSize.ofMegabytes(1);
        @Valid private final DispatchConsumer consumer = new DispatchConsumer();
        @Valid private final DispatchRetry retry = new DispatchRetry();
        @Valid private final DispatchDeadLetter deadLetter = new DispatchDeadLetter();
        @Valid private final DispatchObservability observability = new DispatchObservability();
        @Valid private final DispatchIdempotency idempotency = new DispatchIdempotency();
        @Valid private final DispatchRedis redis = new DispatchRedis();
        @Valid private final DispatchRabbitmq rabbitmq = new DispatchRabbitmq();
        @Valid private final DispatchKafka kafka = new DispatchKafka();
        @Valid private final DispatchOutbox outbox = new DispatchOutbox();
        /** This service's signing key (32+ characters; set it from the environment: PSO_DISPATCH_SIGNING_KEY). When set, every published event is signed. */
        @jakarta.validation.constraints.Size(min = 32, message = "must be at least 32 characters") private String signingKey;
        @Valid private final DispatchTrust trust = new DispatchTrust();
        /**
         * Explicit legacy declaration (PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true): lets a production service start with trust mode off.
         * Insecure; reported at every start. It verifies nothing and is never a substitute for a verified publisher.
         */
        private boolean allowUnauthenticated = false;
        public boolean isAllowUnauthenticated() { return allowUnauthenticated; }
        public void setAllowUnauthenticated(boolean v) { this.allowUnauthenticated = v; }
        public String getSigningKey() { return signingKey; }
        public void setSigningKey(String v) { this.signingKey = v == null || v.isBlank() ? null : v; }
        public DispatchTrust getTrust() { return trust; }
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public String getProvider() { return provider; }
        public void setProvider(String provider) { this.provider = provider; }
        public DataSize getMaxMessageSize() { return maxMessageSize; }
        public void setMaxMessageSize(DataSize v) { this.maxMessageSize = v; }
        public DispatchConsumer getConsumer() { return consumer; }
        public DispatchRetry getRetry() { return retry; }
        public DispatchDeadLetter getDeadLetter() { return deadLetter; }
        public DispatchObservability getObservability() { return observability; }
        public DispatchIdempotency getIdempotency() { return idempotency; }
        public DispatchRedis getRedis() { return redis; }
        public DispatchRabbitmq getRabbitmq() { return rabbitmq; }
        public DispatchKafka getKafka() { return kafka; }
        public DispatchOutbox getOutbox() { return outbox; }
    }

    /** Publisher authentication of consumed events (see com.pso.dispatch.Trust). */
    public static class DispatchTrust {
        /** off (default), permissive (refuse wrong signatures, accept unsigned) or required (every consumed event must be signed by its source). */
        @NotBlank @Pattern(regexp = "^(off|permissive|required)$", message = "must be one of off, permissive, required") private String mode = "off";
        /** service name -> its key(s), comma separated while rotating. PSO_DISPATCH_TRUST_KEY_<SERVICE> variables are read as well. */
        private final Map<String, String> keys = new LinkedHashMap<>();
        public String getMode() { return mode; }
        public void setMode(String v) { this.mode = v; }
        public Map<String, String> getKeys() { return keys; }
    }

    public static class DispatchConsumer {
        @Min(1) @Max(64) private int concurrency = 1;
        @Min(1) @Max(1000) private int batchSize = 10;
        public int getConcurrency() { return concurrency; }
        public void setConcurrency(int v) { this.concurrency = v; }
        public int getBatchSize() { return batchSize; }
        public void setBatchSize(int v) { this.batchSize = v; }
    }

    public static class DispatchRetry {
        private boolean enabled = true;
        @Min(1) @Max(20) private int maxAttempts = 3;
        @NotNull private Duration initialDelay = Duration.ofSeconds(1);
        @NotNull private Duration maxDelay = Duration.ofSeconds(30);
        @Min(1) @Max(10) private double multiplier = 2.0;
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int v) { this.maxAttempts = v; }
        public Duration getInitialDelay() { return initialDelay; }
        public void setInitialDelay(Duration v) { this.initialDelay = v; }
        public Duration getMaxDelay() { return maxDelay; }
        public void setMaxDelay(Duration v) { this.maxDelay = v; }
        public double getMultiplier() { return multiplier; }
        public void setMultiplier(double v) { this.multiplier = v; }
    }

    public static class DispatchDeadLetter {
        private boolean enabled = true;
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
    }

    public static class DispatchObservability {
        private boolean enabled = true;
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
    }

    public static class DispatchIdempotency {
        /** How long a processed event id is remembered. The default store is per process; use a durable store in production. */
        @NotNull private Duration retention = Duration.ofHours(24);
        /** How long a claim of a consumer that died blocks the others; renewed while a handler runs, so not a limit on handler duration. */
        @NotNull private Duration lease = Duration.ofSeconds(30);
        public Duration getRetention() { return retention; }
        public void setRetention(Duration v) { this.retention = v; }
        public Duration getLease() { return lease; }
        public void setLease(Duration v) { this.lease = v; }
    }

    public enum TopologyCreation { AUTO, REQUIRE }

    public static class DispatchRedis {
        /** redis:// or rediss:// URL; credentials come from the environment, never from the file. */
        private String url;
        @Min(100) private long maxLength = 100_000;
        @NotNull private Duration minIdle = Duration.ofSeconds(60);
        @NotNull private Duration block = Duration.ofSeconds(2);
        @NotNull private TopologyCreation streamCreation = TopologyCreation.AUTO;
        public String getUrl() { return url; }
        public void setUrl(String v) { this.url = v; }
        public long getMaxLength() { return maxLength; }
        public void setMaxLength(long v) { this.maxLength = v; }
        public Duration getMinIdle() { return minIdle; }
        public void setMinIdle(Duration v) { this.minIdle = v; }
        public Duration getBlock() { return block; }
        public void setBlock(Duration v) { this.block = v; }
        public TopologyCreation getStreamCreation() { return streamCreation; }
        public void setStreamCreation(TopologyCreation v) { this.streamCreation = v; }
    }

    public static class DispatchRabbitmq {
        /** amqp:// or amqps:// URL; credentials come from the environment. */
        private String url;
        @NotBlank private String exchangePrefix = "pso.";
        public String getUrl() { return url; }
        public void setUrl(String v) { this.url = v; }
        public String getExchangePrefix() { return exchangePrefix; }
        public void setExchangePrefix(String v) { this.exchangePrefix = v; }
    }

    public static class DispatchKafka {
        private List<String> bootstrapServers = new ArrayList<>();
        private String clientId;
        @NotNull private TopologyCreation topicCreation = TopologyCreation.AUTO;
        @Min(1) @Max(1000) private int partitions = 1;
        @Min(1) @Max(10) private int replicationFactor = 1;
        private boolean ssl = false;
        @Valid private final DispatchKafkaSasl sasl = new DispatchKafkaSasl();
        public List<String> getBootstrapServers() { return bootstrapServers; }
        public void setBootstrapServers(List<String> v) { this.bootstrapServers = v == null ? new ArrayList<>() : v; }
        public String getClientId() { return clientId; }
        public void setClientId(String v) { this.clientId = v; }
        public TopologyCreation getTopicCreation() { return topicCreation; }
        public void setTopicCreation(TopologyCreation v) { this.topicCreation = v; }
        public int getPartitions() { return partitions; }
        public void setPartitions(int v) { this.partitions = v; }
        public int getReplicationFactor() { return replicationFactor; }
        public void setReplicationFactor(int v) { this.replicationFactor = v; }
        public boolean isSsl() { return ssl; }
        public void setSsl(boolean v) { this.ssl = v; }
        public DispatchKafkaSasl getSasl() { return sasl; }
    }

    public static class DispatchKafkaSasl {
        /** plain, scram-sha-256 or scram-sha-512; credentials come from the environment and require ssl. */
        private String mechanism;
        private String username;
        private String password;
        public String getMechanism() { return mechanism; }
        public void setMechanism(String v) { this.mechanism = v; }
        public String getUsername() { return username; }
        public void setUsername(String v) { this.username = v; }
        public String getPassword() { return password; }
        public void setPassword(String v) { this.password = v; }
    }

    public static class DispatchOutbox {
        /** Optional transactional outbox (needs a JDBC DataSource): events are stored with the business data and relayed afterwards. */
        private boolean enabled = false;
        @NotNull private Duration pollInterval = Duration.ofSeconds(1);
        @Min(1) @Max(1000) private int batchSize = 50;
        @Min(1) @Max(100) private int maxAttempts = 10;
        @NotNull private Duration retryBackoff = Duration.ofSeconds(5);
        @NotNull private Duration retention = Duration.ofDays(7);
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
        public Duration getPollInterval() { return pollInterval; }
        public void setPollInterval(Duration v) { this.pollInterval = v; }
        public int getBatchSize() { return batchSize; }
        public void setBatchSize(int v) { this.batchSize = v; }
        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int v) { this.maxAttempts = v; }
        public Duration getRetryBackoff() { return retryBackoff; }
        public void setRetryBackoff(Duration v) { this.retryBackoff = v; }
        public Duration getRetention() { return retention; }
        public void setRetention(Duration v) { this.retention = v; }
    }

    public enum DatabaseProvider { NONE, H2, POSTGRESQL }

    public static class Database {
        @NotNull private DatabaseProvider provider = DatabaseProvider.NONE;
        public DatabaseProvider getProvider() { return provider; }
        public void setProvider(DatabaseProvider provider) { this.provider = provider; }
    }

    public static class Observability {
        @Valid private final Correlation correlation = new Correlation();
        /**
         * Development diagnostics: log the message and the stack trace of an unexpected exception. Off by default (a message can
         * quote request data) and never honoured with a production profile. The response is the same sanitized problem either way.
         */
        private boolean errorDetails = false;
        public Correlation getCorrelation() { return correlation; }
        public boolean isErrorDetails() { return errorDetails; }
        public void setErrorDetails(boolean v) { this.errorDetails = v; }
    }

    public static class Correlation {
        private boolean enabled = true;
        @NotBlank @Pattern(regexp = "^[A-Za-z0-9-]+$") private String header = "X-Correlation-ID";
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public String getHeader() { return header; }
        public void setHeader(String header) { this.header = header; }
    }
}
