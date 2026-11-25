package com.pso.it.app;

import com.pso.spring.autoconfigure.problem.PsoProblemException;
import com.pso.spring.http.PsoHttpException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Endpoints that fail on purpose so the error standard can be verified end to end. */
@RestController
@RequestMapping("/probe")
public class ProblemProbeController {

    public record NewUser(@NotBlank String name, @Email String email) {
    }

    @PostMapping(value = "/validate", consumes = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> validate(@Valid @RequestBody NewUser user) {
        return Map.of("name", user.name());
    }

    @GetMapping("/conflict")
    public Map<String, String> conflict() {
        throw new PsoProblemException(HttpStatus.CONFLICT, "conflict", "A product with SKU ABC-1 already exists");
    }

    @GetMapping("/boom")
    public Map<String, String> boom() {
        throw new IllegalStateException("secret internals: jdbc:postgresql://db/prod password=hunter2 at /etc/passwd");
    }

    @GetMapping("/typed/{n}")
    public Map<String, Integer> typed(@PathVariable int n) {
        return Map.of("n", n);
    }

    @GetMapping("/upstream/{kind}")
    public Map<String, String> upstream(@PathVariable String kind) {
        throw new PsoHttpException("customers", PsoHttpException.Kind.valueOf(kind), null, "remote said: internal detail with secret-token-123", null);
    }

    /** A remote service ANSWERED with this status and the application did not handle it. */
    @GetMapping("/upstream-status/{status}")
    public Map<String, String> upstreamStatus(@PathVariable int status) {
        throw new PsoHttpException("customers", status >= 500 ? PsoHttpException.Kind.REMOTE_SERVER_ERROR : PsoHttpException.Kind.REMOTE_CLIENT_ERROR, status,
            "remote said: internal detail with secret-token-123", null);
    }

    /** The application translates a remote "not found" on purpose: the documented way to give a downstream outcome a meaning. */
    @GetMapping("/upstream-translated")
    public Map<String, String> upstreamTranslated() {
        try {
            throw new PsoHttpException("customers", PsoHttpException.Kind.REMOTE_CLIENT_ERROR, 404, "customers answered 404", null);
        } catch (PsoHttpException e) {
            if (e.isStatus(404)) {
                throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY, "unknown customer");
            }
            throw e;
        }
    }
}
