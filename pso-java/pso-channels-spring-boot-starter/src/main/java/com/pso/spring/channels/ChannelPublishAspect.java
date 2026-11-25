package com.pso.spring.channels;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Method;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanInitializationException;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.annotation.Order;
import org.springframework.util.ReflectionUtils;

/**
 * Implements {@link ChannelPublish}. It runs at the LOWEST precedence, i.e. inside the transaction advice of a {@code @Transactional}
 * method, so best-effort events are scheduled for after commit and durable events join the method's transaction.
 */
@Aspect
@Order(Ordered.LOWEST_PRECEDENCE)
public class ChannelPublishAspect {

    private static final Logger LOG = LoggerFactory.getLogger(ChannelPublishAspect.class);
    static final Pattern PLACEHOLDER = Pattern.compile("\\{([A-Za-z][A-Za-z0-9]*)}");
    private final PsoChannelPublisher publisher;
    private final ObjectMapper mapper;

    public ChannelPublishAspect(PsoChannelPublisher publisher, ObjectMapper mapper) {
        this.publisher = publisher;
        this.mapper = mapper;
    }

    @Around("@annotation(spec)")
    public Object publish(ProceedingJoinPoint pjp, ChannelPublish spec) throws Throwable {
        Object result = pjp.proceed(); // an exception propagates: nothing is published for a failed business operation
        if (result == null) {
            LOG.debug("{} returned null: no channel event published", pjp.getSignature().toShortString());
            return null;
        }
        publisher.publish(resolve(spec.channel(), result), spec.event(), result, new PsoChannelPublisher.Options(spec.delivery(), null, null));
        return result;
    }

    /** Fills {property} placeholders of the channel template from the returned object. */
    String resolve(String template, Object result) {
        Matcher m = PLACEHOLDER.matcher(template);
        if (!m.find()) {
            return template;
        }
        JsonNode tree = mapper.valueToTree(result);
        StringBuilder out = new StringBuilder();
        m.reset();
        while (m.find()) {
            JsonNode v = tree.get(m.group(1));
            if (v == null || !(v.isTextual() || v.isNumber()) || !v.asText().matches("[A-Za-z0-9_-]{1,64}")) {
                throw new ChannelPublishException("PSO_CHANNEL_INVALID_CHANNEL", "cannot resolve {" + m.group(1) + "} of the channel \"" + template + "\" from the returned object (missing, not a simple value, or not [A-Za-z0-9_-]{1,64})");
            }
            m.appendReplacement(out, Matcher.quoteReplacement(v.asText()));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** Start-up validation of every annotated method: unsupported declarations fail the application, not the first request. */
    public static final class Validator implements BeanPostProcessor {
        private final java.util.function.BooleanSupplier outboxAvailable;

        public Validator(java.util.function.BooleanSupplier outboxAvailable) {
            this.outboxAvailable = outboxAvailable;
        }

        @Override
        public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
            Class<?> type = AopUtils.getTargetClass(bean);
            ReflectionUtils.doWithMethods(type, (Method method) -> {
                ChannelPublish spec = AnnotatedElementUtils.findMergedAnnotation(method, ChannelPublish.class);
                if (spec == null) {
                    return;
                }
                String at = type.getSimpleName() + "." + method.getName() + " (@ChannelPublish)";
                Class<?> r = method.getReturnType();
                if (r == void.class || r == Void.class || r.isPrimitive() || CharSequence.class.isAssignableFrom(r) || Number.class.isAssignableFrom(r) || r == Boolean.class
                    || r.isArray() || java.util.Collection.class.isAssignableFrom(r) || r == Object.class) {
                    throw new BeanInitializationException(at + ": the return value is the event payload and must be a record or bean (found " + r.getSimpleName() + ")");
                }
                if (java.lang.reflect.Modifier.isPrivate(method.getModifiers()) || java.lang.reflect.Modifier.isFinal(method.getModifiers())) {
                    throw new BeanInitializationException(at + ": a private or final method cannot be intercepted by Spring AOP; make it public and non-final, or use PsoChannelPublisher");
                }
                if (!spec.event().matches("^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$")) {
                    throw new BeanInitializationException(at + ": invalid event type \"" + spec.event() + "\" (dotted lower-case)");
                }
                String literal = PLACEHOLDER.matcher(spec.channel()).replaceAll("x");
                if (!literal.matches("^[a-z][a-z0-9_-]{0,63}(\\.[A-Za-z0-9_-]{1,64}){0,7}$")) {
                    throw new BeanInitializationException(at + ": invalid channel \"" + spec.channel() + "\"");
                }
                if (spec.delivery() == PsoChannelPublisher.Delivery.DURABLE && !outboxAvailable.getAsBoolean()) {
                    throw new BeanInitializationException(at + ": delivery = DURABLE needs the transactional outbox (pso.dispatch.outbox.enabled=true). It is never downgraded to best effort: choose BEST_EFFORT explicitly or enable the outbox.");
                }
            }, ReflectionUtils.USER_DECLARED_METHODS);
            return bean;
        }
    }
}
