import { defineDeployment } from "@pso/deploy";

// The orders microfrontend, deployed as a static resource by the native engine: the same plan, approval, signature check, lock, history, atomic activation and rollback as a service.
// A microfrontend release never touches nginx: one atomic pointer write, after a compatibility check against the active shell.
// Build first: pso frontend:build mei-orders
export default defineDeployment({
  "name": "commerce-orders",
  "environment": "production",
  "connection": {
    "provider": "ssh",
    "credentials": "server"
  },
  "source": {
    "provider": "artifact",
    "path": "artifacts/commerce-frontend/mei-orders"
  },
  "services": [
    {
      "name": "orders",
      "runtime": "static",
      "static": {
        "site": "commerce",
        "kind": "mei",
        "probe": {
          "port": 20003
        }
      }
    }
  ],
  "strategy": {
    "type": "static",
    "proxy": "none"
  }
});
