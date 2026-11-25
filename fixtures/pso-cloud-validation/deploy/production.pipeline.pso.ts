import { definePipeline } from "@pso/deploy";

// Optional stages can be turned off. The mandatory protections (identity, authorization, locking, release integrity, a valid
// proxy configuration, candidate readiness) are part of the engine and are not stages: no setting here disables them.
export default definePipeline({
  "name": "production",
  "stages": [
    {
      "type": "integrity"
    },
    {
      "type": "compatibility"
    },
    {
      "type": "security",
      "enabled": true
    },
    {
      "type": "tests",
      "enabled": false
    },
    {
      "type": "resources"
    },
    {
      "type": "build"
    },
    {
      "type": "health"
    },
    {
      "type": "deploy"
    }
  ]
});
