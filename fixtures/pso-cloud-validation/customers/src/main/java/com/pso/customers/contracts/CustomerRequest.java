package com.pso.customers.contracts;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CustomerRequest(@NotBlank @Size(max = 120) String name, @NotBlank @Email @Size(max = 160) String email) {
}
