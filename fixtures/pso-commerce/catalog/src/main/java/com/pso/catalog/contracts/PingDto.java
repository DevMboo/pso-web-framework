package com.pso.catalog.contracts;

import java.time.Instant;

/** An immutable response: a record needs no Lombok at all. */
public record PingDto(String service, String message, Instant at) {
}
