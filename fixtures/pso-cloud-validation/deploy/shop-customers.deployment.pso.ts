import { defineDeployment } from "@pso/deploy";

// customers: Spring Boot service, systemd user unit, blue-green behind nginx. Owns customer identities (no messaging).
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
  "name": "shop-customers",
  "source": {
    "provider": "artifact",
    "path": "artifacts/customers"
  },
  "service": {
    "name": "customers",
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
    "internalPort": 8201,
    "resources": {
      "memoryMb": 330
    },
    "requires": {
      "java": ">=21"
    },
    "env": {
      "SPRING_PROFILES_ACTIVE": "staging",
      "DB_URL": "jdbc:postgresql://127.0.0.1:5432/customers",
      "DB_USER": "customers",
      "PSO_JWT_ISSUER": "https://pso-cloud-validation.local",
      "PSO_JWT_AUDIENCE": "shop-api",
      "PSO_JWT_JWKS_URI": "http://127.0.0.1:8099/jwks.json",
      "PSO_JWT_ALGORITHMS": "ES256"
    },
    "secrets": {
      "DB_PASSWORD": "customers-db-password"
    },
    "workload": {
      "selfMigrates": true
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
