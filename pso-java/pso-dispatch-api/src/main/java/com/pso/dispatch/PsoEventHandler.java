package com.pso.dispatch;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a method of a Spring bean as the consumer of one event type. The event must be declared (dispatch/*.events.json); the
 * method takes the payload type (a record or bean converted from the JSON payload) and optionally a {@link ConsumeContext}.
 * The message is acknowledged only after the method returns normally.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface PsoEventHandler {

    /** the event type, for example users.created */
    String value();

    /** consumer group; defaults to the service name */
    String group() default "";

    /** messages handled at the same time; 0 uses pso.dispatch.consumer.concurrency */
    int concurrency() default 0;
}
