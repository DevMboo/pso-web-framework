package com.pso.spring.autoconfigure.dispatch;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.DispatchRuntime;
import com.pso.dispatch.PsoEventHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Map;
import org.springframework.aop.support.AopUtils;
import org.springframework.context.ApplicationContext;
import org.springframework.context.SmartLifecycle;
import org.springframework.core.MethodIntrospector;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.util.ReflectionUtils;

/**
 * Discovers {@link PsoEventHandler} methods on Spring beans, registers them with the runtime (an undeclared event or a bad signature
 * stops start-up) and manages the consumer lifecycle: start after the context is ready, drain in-flight messages on shutdown.
 */
final class PsoEventHandlerRegistrar implements SmartLifecycle {

    private final DispatchRuntime runtime;
    private final ApplicationContext ctx;
    private final ObjectMapper mapper;
    private volatile boolean running;

    PsoEventHandlerRegistrar(DispatchRuntime runtime, ApplicationContext ctx, ObjectMapper mapper) {
        this.runtime = runtime;
        this.ctx = ctx;
        this.mapper = mapper;
    }

    @Override
    public synchronized void start() {
        if (running) {
            return;
        }
        for (String name : ctx.getBeanDefinitionNames()) {
            Class<?> type = ctx.getType(name);
            if (type == null) {
                continue;
            }
            Class<?> target = org.springframework.util.ClassUtils.getUserClass(type);
            Map<Method, PsoEventHandler> methods = MethodIntrospector.selectMethods(target, (MethodIntrospector.MetadataLookup<PsoEventHandler>) m -> AnnotatedElementUtils.findMergedAnnotation(m, PsoEventHandler.class));
            if (methods.isEmpty()) {
                continue; // never instantiate a bean just to look at it
            }
            Object bean = ctx.getBean(name);
            for (Map.Entry<Method, PsoEventHandler> e : methods.entrySet()) {
                register(bean, e.getKey(), e.getValue());
            }
        }
        runtime.start();
        running = true;
    }

    private void register(Object bean, Method method, PsoEventHandler a) {
        Class<?>[] p = method.getParameterTypes();
        if (p.length < 1 || p.length > 2 || (p.length == 2 && p[1] != ConsumeContext.class)) {
            throw new IllegalStateException("@PsoEventHandler method " + method + " must take the payload and optionally a ConsumeContext");
        }
        Method invocable = org.springframework.aop.support.AopUtils.selectInvocableMethod(method, bean.getClass());
        ReflectionUtils.makeAccessible(invocable);
        runtime.register(a.value(), a.group(), a.concurrency(), (JsonNode payload, ConsumeContext c) -> {
            Object arg = p[0] == JsonNode.class ? payload : mapper.treeToValue(payload, p[0]);
            try {
                if (p.length == 2) {
                    invocable.invoke(bean, arg, c);
                } else {
                    invocable.invoke(bean, arg);
                }
            } catch (InvocationTargetException ex) {
                Throwable cause = ex.getCause();
                throw cause instanceof Exception e ? e : new IllegalStateException(cause);
            }
        });
    }

    @Override
    public synchronized void stop() {
        if (running) {
            running = false;
            runtime.stop();
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return Integer.MAX_VALUE - 100; // after everything the handlers depend on is ready; stopped first
    }
}
