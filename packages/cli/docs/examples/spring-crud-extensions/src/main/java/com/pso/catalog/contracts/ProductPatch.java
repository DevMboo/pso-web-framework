package com.pso.catalog.contracts;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/** A partial update: only the fields that are present change. An absent field and an explicit null both mean "leave it alone". */
public record ProductPatch(@Size(min = 1, max = 120) String name, @Positive Long priceCents) {

    @AssertTrue(message = "at least one of name or priceCents is required")
    public boolean isChange() {
        return name != null || priceCents != null;
    }
}
