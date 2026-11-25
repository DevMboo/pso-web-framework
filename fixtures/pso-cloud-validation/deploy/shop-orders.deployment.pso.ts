import { defineDeployment } from "@pso/deploy";

// orders: Spring Boot service, systemd user unit, blue-green behind nginx. Owns the order workflow; publishes orders.created through its outbox, consumes inventory.*, notifies through Channels.
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
  "name": "shop-orders",
  "source": {
    "provider": "artifact",
    "path": "artifacts/orders"
  },
  "service": {
    "name": "orders",
    "runtime": "java",
    "start": [
      "java",
      "-Xmx192m",
      "-XX:+UseSerialGC",
      "-jar",
      "app.jar"
    ],
    "health": {
      "readyPath": "/actuator/health",
      "timeoutSeconds": 240
    },
    "shutdownGraceSeconds": 20,
    "internalPort": 8203,
    "resources": {
      "memoryMb": 330
    },
    "requires": {
      "java": ">=21"
    },
    "env": {
      "SPRING_PROFILES_ACTIVE": "staging",
      "DB_URL": "jdbc:postgresql://127.0.0.1:5432/orders",
      "DB_USER": "orders",
      "PSO_DISPATCH_ENABLED": "true",
      "PSO_DISPATCH_TRUST_MODE": "required",
      "PSO_JWT_ISSUER": "https://pso-cloud-validation.local",
      "PSO_JWT_AUDIENCE": "shop-api",
      "PSO_JWT_JWKS_URI": "http://127.0.0.1:8099/jwks.json",
      "PSO_JWT_ALGORITHMS": "ES256"
    },
    "secrets": {
      "DB_PASSWORD": "orders-db-password",
      "RABBITMQ_URL": "rabbitmq-url",
      "PSO_DISPATCH_SIGNING_KEY": "dispatch-key-orders",
      "PSO_DISPATCH_TRUST_KEY_CATALOG": "dispatch-key-catalog"
    },
    "workload": {
      "selfMigrates": true,
      "consumers": [
        "rabbitmq"
      ],
      "outbox": true,
      "channels": true
    }
  },
  "migrations": {
    "mode": "expand-contract"
  },
  "strategy": {
    "type": "blue-green",
    "proxy": "nginx",
    "rollback": true,
    "drainSeconds": 3,
    "retention": {
      "keep": 4
    }
  },
  "proxy": {
    "nginx": {}
  }
});
