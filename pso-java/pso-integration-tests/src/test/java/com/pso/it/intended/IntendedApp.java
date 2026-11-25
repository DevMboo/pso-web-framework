package com.pso.it.intended;

import com.pso.spring.autoconfigure.RepeatsServicePrefix;
import java.util.Map;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** A resource named like the service ("users" in the service whose prefix is /users), declared as intended: it is served at /users/users. */
@SpringBootApplication
public class IntendedApp {

    @RestController
    @RepeatsServicePrefix
    @RequestMapping("/users")
    public static class Users {
        @GetMapping
        public Map<String, String> list() {
            return Map.of("resource", "users");
        }

        @GetMapping("/archive")
        public Map<String, String> archive() {
            return Map.of("resource", "users-archive");
        }
    }

    @RestController
    @RequestMapping("/profiles")
    public static class Profiles {
        @GetMapping
        public Map<String, String> list() {
            return Map.of("resource", "profiles");
        }
    }
}
