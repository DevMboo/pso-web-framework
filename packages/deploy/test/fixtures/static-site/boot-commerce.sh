#!/bin/sh
# Real nginx plus a forwarder to the Commerce orchestrator of the Compose network the container is attached to.
mkdir -p /etc/nginx/pso.d /tmp/agent-home /run/nginx
rm -f /etc/nginx/http.d/default.conf
node /fixture/forward.js "${GATEWAY:-gateway:3000}" &
nginx -t || exit 3
nginx
echo "boot done"
exec tail -f /dev/null
