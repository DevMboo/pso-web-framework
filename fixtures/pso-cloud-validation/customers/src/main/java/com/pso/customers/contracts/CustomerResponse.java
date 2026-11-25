package com.pso.customers.contracts;

import java.util.UUID;

public record CustomerResponse(UUID id, String name, String email) {
}
