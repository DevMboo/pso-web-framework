package com.pso.spring.autoconfigure;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Declares that a controller's own path intentionally begins with the same segment as the service prefix: the resource
 * {@code /orders} of the service whose prefix is {@code /orders} is served at {@code /orders/orders}.
 *
 * <p>Without this declaration PSO refuses to start when a mapping begins with the prefix twice, because that is almost always a
 * controller that wrote the prefix by hand ({@code @RequestMapping("/orders/items")} meant as {@code /orders/items}). The annotation
 * changes no path: the prefix is still applied once, by PSO. {@code pso make:resource} writes it when the resource path it was asked
 * for starts with the service prefix.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface RepeatsServicePrefix {
}
