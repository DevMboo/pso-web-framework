import { defineDeployment } from "@pso/deploy";

// The tutorial's development JWKS publisher (public keys only), on loopback. A production deployment would use the identity provider's JWKS URL.
export default defineDeployment({
  "environment": "production",
  "connection": {
    "provider": "ssh",
    "credentials": "server"
  },
  "pipeline": "production",
  "runtime": {
    "supervisor": "systemd",
    "restart": "on-failure"
  },
  "name": "shop-jwks",
  "source": {
    "provider": "artifact",
    "path": "artifacts/jwks"
  },
  "service": {
    "name": "jwks",
    "runtime": "command",
    "start": [
      "node",
      "dev-jwks.mjs"
    ],
    "port": 8099,
    "health": {
      "readyPath": "/jwks.json",
      "timeoutSeconds": 30
    },
    "shutdownGraceSeconds": 5,
    "resources": {
      "memoryMb": 64
    }
  },
  "strategy": {
    "type": "recreate",
    "proxy": "none",
    "downtimeAcknowledged": true,
    "rollback": true
  }
});
