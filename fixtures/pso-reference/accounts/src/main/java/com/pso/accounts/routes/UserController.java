package com.pso.accounts.routes;

import com.pso.accounts.contracts.UserDto;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.pso.spring.autoconfigure.RepeatsServicePrefix;

// The service prefix /accounts is applied by PSO, so this resource is served at /accounts/accounts/users. The path repeats the prefix on
// purpose (the resource is named like the service): @RepeatsServicePrefix says so, otherwise PSO would refuse it as a mistake.
@RestController
@RepeatsServicePrefix
@RequestMapping("/accounts/users")
public class UserController {

    @PreAuthorize("hasAuthority('SCOPE_users:admin')")
    @GetMapping
    public List<UserDto> list() {
        return List.of(new UserDto("u-1", "ana"), new UserDto("u-2", "bob"));
    }
}
