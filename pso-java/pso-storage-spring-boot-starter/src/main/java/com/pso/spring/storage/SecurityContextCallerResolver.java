package com.pso.spring.storage;

import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;

/** Reads the caller from the Spring Security context (the PSO security starter puts the JWT subject and its authorities there). */
public final class SecurityContextCallerResolver implements StorageAccess.CallerResolver {

    @Override
    public StorageAccess.Caller current() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || !a.isAuthenticated() || a instanceof AnonymousAuthenticationToken) {
            return null;
        }
        Set<String> authorities = a.getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
        return new StorageAccess.Caller(a.getName(), authorities);
    }
}
