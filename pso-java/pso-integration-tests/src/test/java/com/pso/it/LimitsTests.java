package com.pso.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.pso.it.app.TestApp;
import java.io.ByteArrayInputStream;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;

class LimitsTests {

    private static HttpRequest.BodyPublisher text(int bytes) {
        return HttpRequest.BodyPublishers.ofString("{\"v\":\"" + "x".repeat(Math.max(0, bytes - 8)) + "\"}");
    }

    private static HttpRequest.BodyPublisher chunked(int bytes) {
        byte[] data = ("{\"v\":\"" + "x".repeat(Math.max(0, bytes - 8)) + "\"}").getBytes();
        return HttpRequest.BodyPublishers.fromPublisher(HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(data))); // no length: chunked
    }

    private HttpResponse<String> post(int port, String token, HttpRequest.BodyPublisher body) {
        return Http.send(Http.req(port, "/users/customers", token).header("Content-Type", "application/json").POST(body));
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000", "pso.limits.body.max-size=1KB"})
    class BodyLimit extends Base {

        @Test
        void aBodyWithinTheLimitIsAccepted() {
            assertThat(post(port, token(), text(500)).statusCode()).isEqualTo(200);
        }

        @Test
        void aDeclaredOversizedBodyIsRefusedWith413BeforeItIsRead() {
            var r = post(port, token(), text(2000));
            assertThat(r.statusCode()).isEqualTo(413);
            assertThat(r.body()).contains("payload_too_large");
        }

        @Test
        void aChunkedBodyCannotBypassTheLimit() {
            assertThat(post(port, token(), chunked(500)).statusCode()).as("small chunked body").isEqualTo(200);
            assertThat(post(port, token(), chunked(5000)).statusCode()).as("large chunked body (no Content-Length)").isEqualTo(413);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000"})
    class MultipartDisabledByDefault extends Base {
        @Autowired Environment env;

        @Test
        void uploadsAreNotAcceptedUnlessEnabled() {
            assertThat(env.getProperty("spring.servlet.multipart.enabled")).isEqualTo("false");
            var r = Http.send(multipart(port, token(), "f.txt", 100));
            assertThat(r.statusCode()).isEqualTo(415);
            assertThat(r.body()).contains("multipart_not_enabled");
        }
    }

    static HttpRequest.Builder multipart(int port, String token, String name, int size) {
        String boundary = "pso" + System.nanoTime();
        String body = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"\r\nContent-Type: text/plain\r\n\r\n"
            + "a".repeat(size) + "\r\n--" + boundary + "--\r\n";
        return Http.req(port, "/users/customers/upload", token).header("Content-Type", "multipart/form-data; boundary=" + boundary).POST(HttpRequest.BodyPublishers.ofString(body));
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000",
        "pso.limits.multipart.enabled=true", "pso.limits.multipart.max-file-size=1KB", "pso.limits.multipart.max-request-size=4KB"})
    class MultipartLimits extends Base {

        @Test
        void aSmallFileIsAccepted() {
            var r = Http.send(multipart(port, token(), "ok.txt", 500));
            assertThat(r.statusCode()).isEqualTo(200);
            assertThat(r.body()).contains("\"size\":500");
        }

        @Test
        void aFileOverTheFileLimitIsRefused() {
            assertThat(Http.send(multipart(port, token(), "big.txt", 2000)).statusCode()).isEqualTo(413);
        }

        @Test
        void aRequestOverTheRequestLimitIsRefused() {
            assertThat(Http.send(multipart(port, token(), "huge.txt", 20_000)).statusCode()).isEqualTo(413);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=3"})
    class RateLimit extends Base {

        @Test
        void excessRequestsGet429WithRetryAfterAndForgedForwardedHeadersDoNotHelp() {
            for (int i = 0; i < 3; i++) {
                var r = Http.send(Http.req(port, "/users/customers/1", token()).header("X-Forwarded-For", "10.0.0." + i).GET());
                assertThat(r.statusCode()).as("request " + i).isEqualTo(200);
            }
            var limited = Http.send(Http.req(port, "/users/customers/1", token()).header("X-Forwarded-For", "10.9.9.9").GET());
            assertThat(limited.statusCode()).isEqualTo(429);
            assertThat(Long.parseLong(limited.headers().firstValue("Retry-After").orElseThrow())).isBetween(1L, 60L);
            assertThat(limited.body()).contains("too_many_requests");
        }

        @Test
        void healthProbesAreNeverThrottled() {
            for (int i = 0; i < 20; i++) {
                assertThat(Http.get(port, "/actuator/health", null).statusCode()).isEqualTo(200);
            }
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000", "pso.limits.concurrency.max-requests=1"})
    class Concurrency extends Base {

        @Test
        void requestsBeyondTheConcurrencyLimitAreRejectedWith503() throws Exception {
            String t = token();
            CompletableFuture<HttpResponse<String>> slow = CompletableFuture.supplyAsync(() -> Http.get(port, "/users/customers/slow", t));
            Thread.sleep(250);
            var rejected = Http.get(port, "/users/customers/1", t);
            assertThat(rejected.statusCode()).isEqualTo(503);
            assertThat(rejected.headers().firstValue("Retry-After")).isPresent();
            assertThat(slow.get().statusCode()).as("the request already running completes").isEqualTo(200);
            assertThat(Http.get(port, "/actuator/health", null).statusCode()).as("health is exempt").isEqualTo(200);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "pso.service.name=users-service", "pso.limits.requests.per-minute=100000", "pso.limits.header.max-size=1KB"})
    class HeaderLimit extends Base {

        @Test
        void oversizedHeadersAreRefusedByTheContainer() {
            var r = Http.send(Http.req(port, "/users/customers/1", token()).header("X-Big", "h".repeat(4000)).GET());
            assertThat(r.statusCode()).isIn(400, 431);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"pso.service.name=users-service"})
    class DerivedContainerSettings extends Base {
        @Autowired Environment env;

        @Test
        void declarativeLimitsReachTheRealHttpStack() {
            assertThat(env.getProperty("server.max-http-request-header-size")).isEqualTo("16384B");
            assertThat(env.getProperty("server.tomcat.max-http-form-post-size")).isEqualTo("2097152B");
            assertThat(env.getProperty("server.tomcat.connection-timeout")).isEqualTo("10000ms");
            assertThat(env.getProperty("spring.mvc.async.request-timeout")).isEqualTo("30000ms");
        }
    }
}
