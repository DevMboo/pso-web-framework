package com.pso.spring.autoconfigure.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;

/**
 * Enforces the request body limit on the bytes actually read, so chunked requests or a lying Content-Length cannot bypass it.
 * A declared Content-Length over the limit is answered with 413 before the body is touched. Multipart requests use the
 * multipart request-size limit, while the per-file size is enforced by the servlet container's multipart handling.
 */
public class BodySizeLimitFilter extends OncePerRequestFilter {

    private final long maxBody;
    private final long maxMultipart;
    private final boolean multipartEnabled;

    public BodySizeLimitFilter(long maxBody, long maxMultipart, boolean multipartEnabled) {
        this.maxBody = maxBody;
        this.maxMultipart = maxMultipart;
        this.multipartEnabled = multipartEnabled;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        boolean multipart = req.getContentType() != null && req.getContentType().toLowerCase().startsWith(MediaType.MULTIPART_FORM_DATA_VALUE);
        if (multipart && !multipartEnabled) {
            com.pso.spring.autoconfigure.problem.Problems.write(req, res, "multipart_not_enabled");
            return;
        }
        long limit = multipart ? maxMultipart : maxBody;
        long declared = req.getContentLengthLong();
        if (declared > limit) {
            com.pso.spring.autoconfigure.problem.Problems.write(req, res, "payload_too_large");
            return;
        }
        chain.doFilter(new Limited(req, limit), res);
    }

    private static final class Limited extends HttpServletRequestWrapper {
        private final long limit;
        private ServletInputStream stream;

        Limited(HttpServletRequest request, long limit) {
            super(request);
            this.limit = limit;
        }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            if (stream == null) {
                stream = new Counting(super.getInputStream(), limit);
            }
            return stream;
        }

        @Override
        public BufferedReader getReader() throws IOException {
            String enc = getCharacterEncoding();
            Charset cs = enc == null ? StandardCharsets.UTF_8 : Charset.forName(enc);
            return new BufferedReader(new InputStreamReader(getInputStream(), cs));
        }
    }

    private static final class Counting extends ServletInputStream {
        private final ServletInputStream in;
        private final long limit;
        private long read;

        Counting(ServletInputStream in, long limit) {
            this.in = in;
            this.limit = limit;
        }

        private void account(long n) {
            if (n > 0) {
                read += n;
                if (read > limit) {
                    // a runtime exception passes through message converters untouched and is rendered as 413 by Spring MVC
                    throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "payload too large");
                }
            }
        }

        @Override
        public int read() throws IOException {
            int b = in.read();
            if (b >= 0) {
                account(1);
            }
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = in.read(b, off, len);
            account(n);
            return n;
        }

        @Override public boolean isFinished() { return in.isFinished(); }
        @Override public boolean isReady() { return in.isReady(); }
        @Override public void setReadListener(ReadListener l) { in.setReadListener(l); }
        @Override public void close() throws IOException { in.close(); }
    }
}
