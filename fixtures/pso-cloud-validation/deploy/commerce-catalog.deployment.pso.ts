import { defineDeployment } from "@pso/deploy";

// The catalog microfrontend, deployed as a static resource by the native engine: the same plan, approval, signature check, lock, history, atomic activation and rollback as a service.
// A microfrontend release never touches nginx: one atomic pointer write, after a compatibility check against the active shell.
// Build first: pso frontend:build mei-catalog
export default defineDeployment({
  "name": "commerce-catalog",
  "environment": "production",
  "connection": {
    "provider": "ssh",
    "credentials": "server"
  },
  "source": {
    "provider": "artifact",
    "path": "artifacts/commerce-frontend/mei-catalog"
  },
  "services": [
    {
      "name": "catalog",
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
