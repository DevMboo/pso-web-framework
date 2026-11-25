package com.pso.it.mixed;

import com.pso.spring.autoconfigure.RepeatsServicePrefix;
import java.util.Map;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** One controller declares the repetition, another one repeats the prefix without saying so: only the second is a mistake. */
@SpringBootApplication
public class MixedApp {

    @RestController
    @RepeatsServicePrefix
    @RequestMapping("/users")
    public static class Declared {
        @GetMapping
        public Map<String, String> list() {
            return Map.of();
        }
    }

    @RestController
    @RequestMapping("/users/settings")
    public static class Accidental {
        @GetMapping
        public Map<String, String> get() {
            return Map.of();
        }
    }
}
