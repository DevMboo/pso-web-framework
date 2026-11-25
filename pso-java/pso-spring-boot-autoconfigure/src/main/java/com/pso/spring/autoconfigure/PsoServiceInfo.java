package com.pso.spring.autoconfigure;

/** The resolved identity of this service: name and the effective (normalized) endpoint prefix, "" meaning none. */
public record PsoServiceInfo(String name, String prefix) {
}
