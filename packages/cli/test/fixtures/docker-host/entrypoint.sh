#!/bin/sh
ssh-keygen -A >/dev/null
/usr/sbin/sshd
# the Docker socket belongs to the docker group, so the unprivileged deploy user can use it
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group docker
