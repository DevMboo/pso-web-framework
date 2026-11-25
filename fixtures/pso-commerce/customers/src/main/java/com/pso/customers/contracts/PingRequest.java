package com.pso.customers.contracts;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * A request body bound by Jackson: a mutable bean, so Lombok generates the accessors and constructors.
 * Prefer a Java record (see {@link PingDto}) for anything immutable. Never put @Data on a JPA entity.
 */
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PingRequest {

    @NotBlank
    @Size(max = 200)
    private String message;
}
