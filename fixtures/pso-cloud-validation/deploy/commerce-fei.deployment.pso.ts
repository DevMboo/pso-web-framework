import { defineDeployment } from "@pso/deploy";

// The application shell, deployed as a static resource by the native engine: the same plan, approval, signature check, lock, history, atomic activation and rollback as a service.
// Only a shell release changes nginx (validated with nginx -t before a graceful reload); microfrontends are served through its configuration.
// Build first: pso frontend:build fei-commerce --base-path /commerce/
export default defineDeployment({
  "name": "commerce-fei",
  "environment": "production",
  "connection": {
    "provider": "ssh",
    "credentials": "server"
  },
  "source": {
    "provider": "artifact",
    "path": "artifacts/commerce-frontend/fei-commerce"
  },
  "services": [
    {
      "name": "shell",
      "runtime": "static",
      "static": {
        "site": "commerce",
        "kind": "fei",
        "basePath": "/commerce/",
        "runtimeConfig": {
          "orchestratorBasePath": "/",
          "channelsPath": "/channels",
          "auth": {
            "kind": "dev-token"
          },
          "requireSignature": true,
          "trustedKeys": [
            {
              "keyId": "release-1",
              "publicKey": "f63v_S5kb02B-Rgvg-VOqGLOOZoKh7OewGSloHgHoTc"
            }
          ]
        },
        "probe": {
          "port": 20003
        }
      }
    }
  ],
  "strategy": {
    "type": "static",
    "proxy": "nginx"
  },
  "proxy": {
    "nginx": {
      "attachTo": "shop-gateway"
    }
  }
});
