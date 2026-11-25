package {{pkg}}.routes;

import {{pkg}}.contracts.PingDto;
import {{pkg}}.contracts.PingRequest;
import {{pkg}}.application.PingService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Example controller. The mapping is "/ping": PSO adds the service prefix once (so this is served at {{prefix}}/ping).
 * Authentication is enforced by the PSO security starter; authorization is declared here with method security (scopes become
 * SCOPE_* authorities), or in application.yml under pso.security.rules.
 */
@RestController
@RequestMapping("/ping")
@RequiredArgsConstructor
public class PingController {

    private final PingService service;

    @PostMapping
    @PreAuthorize("hasAuthority('SCOPE_ping:write')")
    public PingDto ping(@Valid @RequestBody PingRequest request) {
        return service.ping(request);
    }
}
