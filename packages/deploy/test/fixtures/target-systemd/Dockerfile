# A disposable Linux "VPS" WITH systemd as PID 1, for validating the systemd runtime driver of PSO Cloud Lifecycle & Operations.
# sshd, nginx, Node, Java 21 (what generated PSO Spring services target), PostgreSQL, git; an UNPRIVILEGED deploy user `pso`; nothing
# prepared for PSO (the administrator steps from `provision:plan` are run by the test). Needs `docker run --privileged --cgroupns=host`.
FROM node:24-bookworm-slim AS node
FROM eclipse-temurin:21-jdk-jammy AS jdk
FROM debian:12-slim
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd \
      openssh-server nginx git sudo curl ca-certificates postgresql procps iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default \
 && sed -i 's#^\(\s*\)include /etc/nginx/conf.d/\*.conf;#\1include /etc/nginx/conf.d/*.conf;\n\1include /etc/nginx/pso.d/*.conf;#' /etc/nginx/nginx.conf \
 && useradd -m -s /bin/bash pso && useradd -m -s /bin/bash pwuser && echo "pwuser:Pw-Test-12345" | chpasswd \
 && mkdir -p /srv/repos /run/sshd && chown pso: /srv/repos \
 && printf 'Port 22\nPasswordAuthentication yes\nPubkeyAuthentication yes\nUsePAM yes\nAllowUsers pso pwuser\nPermitRootLogin no\nSubsystem sftp internal-sftp\n' > /etc/ssh/sshd_config \
 && systemctl enable ssh nginx postgresql \
 && systemctl mask getty.target console-getty.service systemd-logind.service.d 2>/dev/null; true
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /opt/java/openjdk/bin/java /usr/local/bin/java && ln -sf /opt/java/openjdk/bin/javac /usr/local/bin/javac \
 && printf 'server {\n    listen 8081;\n    server_name unrelated.example.test;\n    location / { return 200 "unrelated site\n"; }\n}\n' > /etc/nginx/conf.d/unrelated.conf
EXPOSE 22 8080 8081
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
