package com.pso.it.app;

import com.pso.spring.http.PsoHttpClient;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Calls a configured remote service through PsoHttpClient so the call can be traced end to end. */
@RestController
@RequestMapping("/trace")
public class ObservabilityProbeController {

    private final PsoHttpClient http;

    public ObservabilityProbeController(PsoHttpClient http) {
        this.http = http;
    }

    @GetMapping("/call")
    public Map<String, String> call() {
        return Map.of("remote", http.get("up", "/ping", String.class));
    }
}
