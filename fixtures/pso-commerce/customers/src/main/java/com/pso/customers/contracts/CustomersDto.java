package com.pso.customers.contracts;

/** A customer as the API returns it. */
public record CustomersDto(String id, String name, String email, String status) {
}
