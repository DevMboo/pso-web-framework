package com.pso.spring.http;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.ssl.pem.PemSslStoreBundle;
import org.springframework.boot.ssl.pem.PemSslStoreDetails;

/**
 * TLS material in PEM files: the format the rest of PSO already uses for the same certificates (the orchestrator's
 * {@code PSO_UPSTREAM_<NAME>_TLS_CA_FILE}, the JWKS authority {@code pso.security.jwt.ca-file}, what {@code pso tls:init} writes).
 * A service can therefore trust another service with the very file the orchestrator uses, without converting it to PKCS12.
 * <p>
 * Nothing here weakens verification: the files only say WHICH authorities are trusted and WHICH client certificate is presented.
 * Messages name the file and the reason, never a password or any content of a key.
 */
final class PemMaterial {

    private PemMaterial() {
    }

    /** A trust store holding every certificate of a PEM file. An expired or not yet valid authority is named here, at start-up. */
    static KeyStore trustStore(String caFile) throws Exception {
        List<X509Certificate> certificates = certificates(caFile, "tls.ca-file");
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        int i = 0;
        for (X509Certificate c : certificates) {
            checkValidity(c, "the certificate authority", caFile);
            store.setCertificateEntry("ca-" + i++, c);
        }
        return store;
    }

    /** A key store with the client certificate (and its chain) and its private key: mutual TLS. */
    static KeyStore keyStore(String certFile, String keyFile, String keyPassword) throws Exception {
        for (X509Certificate c : certificates(certFile, "tls.cert-file")) {
            checkValidity(c, "the client certificate", certFile);
        }
        String key = read(keyFile, "tls.key-file");
        if (!key.contains("PRIVATE KEY-----")) {
            throw new PemException("tls.key-file " + keyFile + " contains no PEM private key");
        }
        PemSslStoreDetails details = PemSslStoreDetails.forCertificate(read(certFile, "tls.cert-file")).withPrivateKey(key);
        if (keyPassword != null && !keyPassword.isEmpty()) {
            details = details.withPrivateKeyPassword(keyPassword);
        }
        try {
            KeyStore store = new PemSslStoreBundle(details, null).getKeyStore();
            if (store == null || !store.aliases().hasMoreElements()) {
                throw new PemException("tls.cert-file / tls.key-file hold no usable certificate and key");
            }
            return store;
        } catch (PemException e) {
            throw e;
        } catch (RuntimeException e) {
            // the cause can quote key material or a password: only its type is reported
            throw new PemException("the private key in " + keyFile + " could not be read (" + e.getClass().getSimpleName()
                + "): it must be an RSA or EC key in PEM, and tls.key-password must be set when it is encrypted");
        }
    }

    private static List<X509Certificate> certificates(String file, String property) throws Exception {
        String pem = read(file, property);
        List<X509Certificate> out = new ArrayList<>();
        try {
            for (Certificate c : CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)))) {
                if (c instanceof X509Certificate x) {
                    out.add(x);
                }
            }
        } catch (Exception e) {
            throw new PemException(property + " " + file + " is not a valid PEM certificate file");
        }
        if (out.isEmpty()) {
            throw new PemException(property + " " + file + " contains no certificate");
        }
        return out;
    }

    private static String read(String file, String property) throws Exception {
        try {
            return Files.readString(Path.of(file), StandardCharsets.US_ASCII);
        } catch (NoSuchFileException e) {
            throw new PemException(property + " not found: " + file);
        } catch (java.io.IOException e) {
            throw new PemException(property + " " + file + " could not be read (" + e.getClass().getSimpleName() + ")");
        }
    }

    private static void checkValidity(X509Certificate c, String what, String file) {
        DateTimeFormatter day = DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC);
        try {
            c.checkValidity();
        } catch (CertificateExpiredException e) {
            throw new PemException(what + " in " + file + " expired on " + day.format(c.getNotAfter().toInstant()));
        } catch (CertificateNotYetValidException e) {
            throw new PemException(what + " in " + file + " is not valid before " + day.format(c.getNotBefore().toInstant()));
        }
    }

    /** A problem with a PEM file whose message is safe to show as it is. */
    static final class PemException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        PemException(String message) {
            super(message);
        }
    }
}
