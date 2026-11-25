---
title: Deterministic manifests
description: Reproducible resource manifests with a content digest - what is in them, why they are stable, and how to use them in CI and releases.
order: 5
keywords: [manifest, digest, sha256, reproducible, validate --write-manifest]
related: [concepts/structural-discovery, devops/ci-cd, devops/build-and-deploy]
---
`pso validate --write-manifest` writes `.pso/manifest.json` for every project. It is the machine-readable answer to "what resources does this project contain?".

```bash
pso validate --write-manifest
```

```text evidence="verified"
gateway: 4 resource(s), digest 504dbdc1f099
catalog: 3 resource(s), digest 6c847b46dc80
OK
```

(A workspace created with `--template empty`, with a `product` module in the gateway and the generated `catalog` service. The digests depend on the project's structure, so yours will differ.)

```json evidence="verified" title=".pso/manifest.json (gateway; the file ends with the full digest)"
{
  "schemaVersion": 1,
  "runtime": "node",
  "resources": [
    { "key": "controller:product/product", "kind": "controller", "id": "product", "file": "src/modules/product/controllers/product.controller.ts" },
    { "key": "guard:jwt", "kind": "guard", "id": "jwt", "file": "src/.app/guards/jwt.guard.ts" },
    { "key": "module:product", "kind": "module", "id": "product", "file": "src/modules/product/MODULE.pso.ts" },
    { "key": "route-registry:product", "kind": "route-registry", "id": "product", "file": "src/modules/product/routes/ROUTES.pso.ts" }
  ],
  "digest": "504dbdc1f099a93b8588be86a418a5bb12a97883..."
}
```

The manifest contains **no timestamps and no absolute paths**, and resources are sorted byte-wise, so the same tree always yields the same digest, on any machine and any file system order. Module-local files are namespaced by their module (`controller:customer/customer`), so two modules can use the same file name without a duplicate error.

## Proving it

Run the command twice with nothing changed in between: the two files have the same SHA-256 (reproduced by `docs-discovery.test.ts`). Add a module and a controller and the digest changes; remove them and the digest returns to the original value.

## What it is for

| Use | How |
|---|---|
| detect that the structure changed | compare digests in CI between two commits |
| cache | key a build cache on the digest instead of on file timestamps |
| release identity | record the digest next to a release so you can tell what structure shipped |
| review | the resource list in a pull request shows added or removed controllers, guards and contracts |

## What it is not

- It does not include file *contents*: two projects with the same structure and different code have the same digest. Use the artifact checksums (`pso build`) for content identity.
- It is not a security signature. Signing belongs to [signed packages](/devops/distribution-and-installation).

## Common mistakes

- Committing `.pso/` (it is in the generated `.gitignore` on purpose; regenerate it).
- Expecting the digest to change when only the body of a function changed.

## Next steps

- [Structural discovery](/concepts/structural-discovery)
- [CI/CD](/devops/ci-cd)
