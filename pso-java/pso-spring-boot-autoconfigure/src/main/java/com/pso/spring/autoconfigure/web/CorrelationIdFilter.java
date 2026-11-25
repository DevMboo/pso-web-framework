package com.pso.spring.autoconfigure.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;

/** Accepts a well-formed incoming correlation id (so one request can be followed across services) or generates one. */
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String MDC_KEY = "correlationId";
    private static final Pattern SAFE = Pattern.compile("^[A-Za-z0-9._-]{8,64}$");

    private final String header;

    public CorrelationIdFilter(String header) {
        this.header = header;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String incoming = req.getHeader(header);
        String id = incoming != null && SAFE.matcher(incoming).matches() ? incoming : UUID.randomUUID().toString();
        res.setHeader(header, id);
        MDC.put(MDC_KEY, id);
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
