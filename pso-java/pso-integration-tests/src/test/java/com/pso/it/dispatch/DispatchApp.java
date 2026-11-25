package com.pso.it.dispatch;

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.stereotype.Component;

/** A real Spring Boot application consuming through @PsoEventHandler. */
@SpringBootApplication
public class DispatchApp {

    public record UserCreated(String run, int n, String mode) {
    }

    @Component
    public static class Handlers {
        public final List<String> seen = new CopyOnWriteArrayList<>();

        @PsoEventHandler("it.user-created")
        public void on(UserCreated e, ConsumeContext ctx) {
            if (e.mode().equals("always-fail") || (e.mode().equals("fail-twice") && ctx.attempt() < 3)) {
                throw new IllegalStateException("boom");
            }
            seen.add(e.run() + ":" + e.n() + ":attempt" + ctx.attempt());
        }
    }
}
