# Linux tools image for the end-to-end tests of two adapters that only run on Linux hosts:
#   - the Secret Service credential provider (secret-tool against a real gnome-keyring on a private D-Bus session);
#   - the Java dependency scan (the official OSV-Scanner binary, which queries osv.dev live).
# Built by the tests themselves when it is missing (docker build packages/deploy/test/fixtures/linux-tools -t pso-e2e-linuxtools:1).
FROM ghcr.io/google/osv-scanner:v2.2.4 AS osv
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gnome-keyring libsecret-tools dbus dbus-x11 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=osv /osv-scanner /usr/local/bin/osv-scanner
RUN useradd -m pso
USER pso
WORKDIR /home/pso
