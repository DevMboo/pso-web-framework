import { defineDeployment } from "@pso/deploy";

// The PSO orchestrator: the only public entry point, HTTPS on the server's IP address with a private CA certificate (IP SAN), WebSocket Channels.
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
  "name": "shop-gateway",
  "source": {
    "provider": "artifact",
    "path": "artifacts/gateway-stage"
  },
  "service": {
    "name": "gateway",
    "runtime": "node",
    "start": [
      "node",
      "dist/main.js"
    ],
    "health": {
      "readyPath": "/health/ready",
      "timeoutSeconds": 90
    },
    "shutdownGraceSeconds": 20,
    "route": {
      "path": "/"
    },
    "resources": {
      "memoryMb": 160
    },
    "requires": {
      "node": ">=24"
    },
    "env": {
      "PSO_JWT_ISSUER": "https://pso-cloud-validation.local",
      "PSO_JWT_AUDIENCE": "shop-api",
      "PSO_JWT_JWKS_URI": "http://127.0.0.1:8099/jwks.json",
      "PSO_JWT_ALGORITHMS": "ES256",
      "PSO_WORKSPACE": "pso.workspace.json",
      "NODE_ENV": "production",
      "PSO_DISPATCH_ENABLED": "true",
      "PSO_DISPATCH_TRUST_MODE": "required",
      "PSO_CHANNELS_ALLOWED_ORIGINS": "https://203.0.113.10,https://127.0.0.1:18443",
      "PSO_CHANNELS_BUS": "redis",
      "PSO_CHANNELS_REDIS_URL": "redis://127.0.0.1:6379",
      "RATE_LIMIT_PROVIDER": "redis",
      "RATE_LIMIT_REDIS_URL": "redis://127.0.0.1:6379"
    },
    "secrets": {
      "RABBITMQ_URL": "rabbitmq-url",
      "PSO_DISPATCH_TRUST_KEY_ORDERS": "dispatch-key-orders",
      "PSO_CHANNELS_BUS_SECRET": "channels-bus-secret"
    },
    "workload": {
      "channels": true,
      "consumers": [
        "rabbitmq"
      ]
    }
  },
  "strategy": {
    "type": "blue-green",
    "proxy": "nginx",
    "rollback": true,
    "drainSeconds": 5,
    "retention": {
      "keep": 4
    }
  },
  "proxy": {
    "nginx": {
      "listen": {
        "http": 80,
        "https": 443
      },
      "tls": {
        "certificate": "/etc/ssl/pso/server.pem",
        "key": "/etc/ssl/pso/server.key"
      },
      "websocket": true,
      "attachPoint": true
    }
  }
});
