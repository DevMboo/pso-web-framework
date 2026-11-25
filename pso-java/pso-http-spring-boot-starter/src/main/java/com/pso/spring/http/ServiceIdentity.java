package com.pso.spring.http;

import java.net.Socket;
import java.security.cert.CertificateException;
import java.security.cert.CertificateParsingException;
import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Pins the SERVICE identity: after the normal chain and host name verification (which the JDK always performs and which stays on), the
 * server certificate must also carry the configured name as a DNS or IP subject alternative name. It can only make verification
 * stricter, never weaker.
 */
final class ServiceIdentity {

    private ServiceIdentity() {
    }

    static TrustManager[] pin(TrustManager[] managers, String expected) {
        TrustManager[] out = new TrustManager[managers.length];
        for (int i = 0; i < managers.length; i++) {
            out[i] = managers[i] instanceof X509TrustManager x ? new Pinning(x, expected) : managers[i];
        }
        return out;
    }

    static boolean carries(X509Certificate cert, String expected) {
        String want = expected.toLowerCase(Locale.ROOT);
        try {
            Collection<List<?>> names = cert.getSubjectAlternativeNames();
            if (names == null) {
                return false;
            }
            for (List<?> n : names) {
                int type = (Integer) n.get(0);
                String value = String.valueOf(n.get(1)).toLowerCase(Locale.ROOT);
                if ((type == 2 || type == 7) && (value.equals(want) || (type == 2 && wildcard(value, want)))) {
                    return true;
                }
            }
        } catch (CertificateParsingException e) {
            return false;
        }
        return false;
    }

    /** *.example.com matches exactly one extra label. */
    private static boolean wildcard(String pattern, String host) {
        if (!pattern.startsWith("*.")) {
            return false;
        }
        int dot = host.indexOf('.');
        return dot > 0 && host.substring(dot).equals(pattern.substring(1)) && host.indexOf('.') == dot && !host.substring(0, dot).isEmpty();
    }

    private static final class Pinning extends X509ExtendedTrustManager {
        private final X509TrustManager delegate;
        private final String expected;

        Pinning(X509TrustManager delegate, String expected) {
            this.delegate = delegate;
            this.expected = expected;
        }

        private void pin(X509Certificate[] chain) throws CertificateException {
            if (chain == null || chain.length == 0 || !carries(chain[0], expected)) {
                throw new CertificateException("the server certificate does not carry the expected service identity \"" + expected + "\"");
            }
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            if (delegate instanceof X509ExtendedTrustManager e) { e.checkServerTrusted(chain, authType, socket); } else { delegate.checkServerTrusted(chain, authType); }
            pin(chain);
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            if (delegate instanceof X509ExtendedTrustManager e) { e.checkServerTrusted(chain, authType, engine); } else { delegate.checkServerTrusted(chain, authType); }
            pin(chain);
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            delegate.checkServerTrusted(chain, authType);
            pin(chain);
        }

        @Override public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException { delegate.checkClientTrusted(chain, authType); }
        @Override public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException { delegate.checkClientTrusted(chain, authType); }
        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException { delegate.checkClientTrusted(chain, authType); }
        @Override public X509Certificate[] getAcceptedIssuers() { return delegate.getAcceptedIssuers(); }
    }
}
