package com.pso.spring.autoconfigure;

import org.springframework.core.env.Environment;

/** What the PSO starters call production: what the Node runtime calls production (PSO_ENV=production) or a Spring profile named prod / production. */
public final class PsoEnvironment {

    private PsoEnvironment() {
    }

    public static boolean isProduction(Environment environment) {
        if ("production".equals(environment.getProperty("PSO_ENV"))) {
            return true;
        }
        for (String p : environment.getActiveProfiles()) {
            if (p.equals("prod") || p.equals("production")) {
                return true;
            }
        }
        return false;
    }
}
