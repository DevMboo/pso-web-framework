package com.pso.spring.http;

import java.util.concurrent.Future;
import org.springframework.http.HttpMethod;

/**
 * Secure outbound HTTP to named services. Semantics:
 * <ul>
 *   <li>The first argument is a service name declared under {@code pso.http.client.services}; anything else fails with
 *       {@link PsoHttpException.Kind#POLICY} before any network I/O. Paths are relative to the service's base URL.</li>
 *   <li>Redirects are never followed, so a remote cannot steer a call to another host.</li>
 *   <li>The caller's bearer token is forwarded only to services configured with {@code forward-bearer: true}.</li>
 *   <li>Idempotent methods (GET, HEAD, PUT, DELETE, OPTIONS) are retried on connection failures, timeouts and 502/503/504, up
 *       to {@code retry.max-attempts}. POST and PATCH are retried only with an Idempotency-Key and {@code retry-non-idempotent}.</li>
 *   <li>Responses larger than {@code max-response-size} fail with {@link PsoHttpException.Kind#RESPONSE_TOO_LARGE}.</li>
 * </ul>
 */
public interface PsoHttpClient {

    <T> T get(String service, String path, Class<T> type, Object... uriVariables);

    <T> T post(String service, String path, Object body, Class<T> type, Object... uriVariables);

    <T> T put(String service, String path, Object body, Class<T> type, Object... uriVariables);

    <T> T patch(String service, String path, Object body, Class<T> type, Object... uriVariables);

    void delete(String service, String path, Object... uriVariables);

    /** Full control (headers, idempotency key). {@code type} may be {@code Void.class}. */
    <T> T exchange(PsoRequest request, Class<T> type);

    /** Runs the call on a virtual thread. {@code Future.cancel(true)} interrupts it (best effort: the remote may still process it). */
    <T> Future<T> exchangeAsync(PsoRequest request, Class<T> type);

    default <T> Future<T> getAsync(String service, String path, Class<T> type, Object... uriVariables) {
        return exchangeAsync(PsoRequest.of(HttpMethod.GET, service, path, uriVariables), type);
    }
}
