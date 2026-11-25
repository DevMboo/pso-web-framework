package com.pso.spring.channels;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pso.dispatch.PsoDispatch;
import com.pso.spring.autoconfigure.PsoAutoConfiguration;
import com.pso.spring.autoconfigure.PsoProperties;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import com.pso.spring.autoconfigure.dispatch.PsoDispatchAutoConfiguration;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Off unless {@code pso.channels.enabled=true}. It needs PSO Dispatch (the transport to the orchestrator) and fails at start-up, naming the
 * fix, when Dispatch is disabled; it never publishes anywhere else.
 */
@AutoConfiguration(after = {PsoAutoConfiguration.class, PsoDispatchAutoConfiguration.class})
@ConditionalOnProperty(prefix = "pso.channels", name = "enabled", havingValue = "true")
public class PsoChannelsAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(PsoChannelPublisher.class)
    PsoChannelPublisher psoChannelPublisher(PsoDispatch dispatch, ObjectProvider<Outbox> outbox, PsoServiceInfo info, PsoProperties props, ObjectProvider<ObjectMapper> mapper) {
        if (dispatch instanceof PsoDispatch.Disabled) {
            // like PsoDispatch itself while disabled (and as in the tests of a service): the application starts, and using the publisher fails clearly
            String why = "channel events travel over PSO Dispatch, which is disabled: install a provider (`pso dispatch:install <redis|rabbitmq|kafka>`), set pso.dispatch.enabled=true and declare the \"" + props.getChannels().getDispatchEvent() + "\" event (`pso channels:enable`)";
            LoggerFactory.getLogger(PsoChannelsAutoConfiguration.class).warn("pso.channels.enabled=true but {}: publishing will fail until then", why);
            return new PsoChannelPublisher() {
                @Override
                public Outcome publish(String channel, String eventType, Object payload, Options options) {
                    throw new ChannelPublishException("PSO_CHANNEL_TRANSPORT", "cannot publish \"" + eventType + "\": " + why);
                }

                @Override
                public Metrics metrics() {
                    return new Metrics(0, 0, 0, 0, 0);
                }
            };
        }
        return new DispatchChannelPublisher(dispatch, outbox::getIfAvailable, info.name(), props.getChannels().getDispatchEvent(), props.getChannels().getMaxPayload().toBytes(), mapper.getIfAvailable(ObjectMapper::new));
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.aspectj.lang.annotation.Aspect")
    static class AnnotationSupport {
        @Bean
        ChannelPublishAspect psoChannelPublishAspect(PsoChannelPublisher publisher, ObjectProvider<ObjectMapper> mapper) {
            return new ChannelPublishAspect(publisher, mapper.getIfAvailable(ObjectMapper::new));
        }

        @Bean
        static ChannelPublishAspect.Validator psoChannelPublishValidator(ObjectProvider<Outbox> outbox) {
            return new ChannelPublishAspect.Validator(() -> outbox.getIfAvailable() != null);
        }
    }
}
