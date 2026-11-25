#!/bin/sh
# Starts the upstream stand-in and nginx (with the include of /etc/nginx/pso.d that the managed adapter writes into), then waits.
mkdir -p /etc/nginx/pso.d /tmp/agent-home /run/nginx
rm -f /etc/nginx/http.d/default.conf
node /fixture/upstream.js &
nginx -t || exit 3
nginx
echo "boot done"
exec tail -f /dev/null
