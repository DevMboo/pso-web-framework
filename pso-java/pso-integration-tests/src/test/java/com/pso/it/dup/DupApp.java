package com.pso.it.dup;

import java.util.Map;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** A controller that already contains the service prefix: PSO must refuse to start rather than serve /users/users/x. */
@SpringBootApplication
public class DupApp {

    @RestController
    @RequestMapping("/users/x")
    public static class Dup {
        @GetMapping
        public Map<String, String> get() {
            return Map.of();
        }
    }
}
