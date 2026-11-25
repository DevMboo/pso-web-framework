package com.pso.it;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** Real HTTP calls with the JDK client: no mocks between the test and the server. */
final class Http {

    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    private Http() {
    }

    static HttpResponse<String> send(HttpRequest.Builder b) {
        try {
            return CLIENT.send(b.timeout(Duration.ofSeconds(15)).build(), HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            throw new IllegalStateException(e);
        }
    }

    static HttpRequest.Builder req(int port, String path, String token) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (token != null) {
            b.header("Authorization", "Bearer " + token);
        }
        return b;
    }

    static HttpResponse<String> get(int port, String path, String token) {
        return send(req(port, path, token).GET());
    }
}
