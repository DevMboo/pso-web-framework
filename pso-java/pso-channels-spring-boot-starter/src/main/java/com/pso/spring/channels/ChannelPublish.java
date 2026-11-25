package com.pso.spring.channels;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Publishes the RETURN VALUE of a Spring bean method as a channel event after the method returns normally.
 *
 * <ul>
 *   <li>The return value is the event payload: a record or bean (not void, a primitive, a String, a number, an array or a collection:
 *       that is a start-up error). A {@code null} return publishes nothing.</li>
 *   <li>An exception means no event. Inside a transaction the semantics are those of {@link PsoChannelPublisher}: best effort is sent only
 *       after commit, {@link PsoChannelPublisher.Delivery#DURABLE} is written to the outbox in the same transaction (a rollback removes it).
 *       Declare the method {@code @Transactional} for durable delivery.</li>
 *   <li>Like every Spring AOP feature it works through the Spring proxy: a call from another method of the SAME object (self-invocation),
 *       a private method, or an object not created by Spring is not intercepted. Use {@link PsoChannelPublisher} explicitly there.</li>
 *   <li>Each invocation publishes once.</li>
 * </ul>
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface ChannelPublish {

    /** The channel. {@code {property}} placeholders are filled from the returned object: {@code "candidate.{candidateId}"}. Values must be [A-Za-z0-9_-]{1,64}. */
    String channel();

    /** The event type, dotted lower-case, for example {@code candidate.updated}. */
    String event();

    PsoChannelPublisher.Delivery delivery() default PsoChannelPublisher.Delivery.BEST_EFFORT;
}
