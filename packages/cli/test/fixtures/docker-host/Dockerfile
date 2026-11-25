# A disposable, isolated Linux host for validating PSO remote deployment: sshd (key authentication only, no root login), Docker Engine and
# Compose, an unprivileged deploy user in the docker group, curl and coreutils. Nothing PSO-specific is installed: the deployment brings
# everything. Run it with --privileged (Docker in Docker). NEVER a production server.
FROM docker:27-dind
RUN apk upgrade --no-cache \
 && apk add --no-cache openssh-server bash coreutils tar curl shadow iproute2 \
 && adduser -D -s /bin/bash pso \
 && echo "pso:$(head -c 18 /dev/urandom | base64)" | chpasswd \
 && (addgroup -S docker 2>/dev/null || true) && addgroup pso docker \
 && mkdir -p /home/pso/.ssh /srv/pso && chown -R pso: /home/pso /srv/pso && chmod 700 /home/pso/.ssh \
 && printf 'Port 22\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin no\nAllowUsers pso\nPerSourcePenalties no\nAllowTcpForwarding local\nSubsystem sftp internal-sftp\n' > /etc/ssh/sshd_config
COPY entrypoint.sh /pso-entrypoint.sh
RUN chmod +x /pso-entrypoint.sh
ENV DOCKER_TLS_CERTDIR=""
EXPOSE 22
ENTRYPOINT ["/pso-entrypoint.sh"]
