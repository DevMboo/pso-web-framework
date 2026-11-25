---
title: Kubernetes, ECS, Container Apps and Cloud Run descriptors
description: Generate hardened deployment descriptors for four platforms, validate them statically, and understand exactly what was and was not verified.
order: 10
status: partial
keywords: [kubernetes, ecs, fargate, container apps, cloud run, deploy:init, deploy:validate, networkpolicy, securitycontext]
related: [devops/docker, devops/distribution-and-installation, security/checklist]
---
> [!STATUS]
> The descriptors are **generated and statically validated**. They have **not been applied to any cluster or cloud account**. A hardened container run (non-root uid, read-only root file system, all capabilities dropped, health endpoint reachable) was verified locally with Docker; that is not a verification of any cloud platform.

```bash
pso deploy:init --target kubernetes     --registry registry.example.com/pso --tag 1.2.3
pso deploy:init --target ecs            --registry registry.example.com/pso --tag 1.2.3
pso deploy:init --target container-apps --registry registry.example.com/pso --tag 1.2.3
pso deploy:init --target cloud-run      --registry registry.example.com/pso --tag 1.2.3
pso deploy:validate            # add --strict to fail while CHANGE_ME values remain
```

Files go to `deploy/<target>/`. Nothing is applied anywhere and existing files are never overwritten without `--force`.

## What every target gets

| Property | Kubernetes | ECS (Fargate) | Container Apps | Cloud Run |
|---|---|---|---|---|
| Non-root, numeric uid | `runAsNonRoot`, `runAsUser` | `user` | image user | image user |
| Read-only root file system, no capabilities | yes | yes | image defaults | platform sandbox |
| Probes on the service health path | readiness + liveness | `healthCheck` | Readiness + Liveness | startup + liveness |
| Resource limits | requests + limits | task cpu/memory | cpu/memory | cpu/memory |
| Secrets | referenced from a ConfigMap/Secret you create | `valueFrom` Secrets Manager ARNs | Key Vault references | Secret Manager references |
| Only the orchestrator is public | NetworkPolicy default deny + allow from the orchestrator | no load balancer for services | `external: false` for services | `ingress: internal` for services |

Images must be pushed by you; tags are fixed versions (`latest` is refused). Services listen on `0.0.0.0` inside the container through `HOST`.

## What `deploy:validate` checks

Run from the files **as they are on disk** (including your edits): root user, writable root file system, privilege escalation, capabilities, seccomp, host namespaces and `hostPath`, missing probes or limits, `latest` tags, secrets written inline, insecure ingress, and unfilled `CHANGE_ME` placeholders (warnings). It is a text-based policy check, not a schema validator for each platform: `kubectl`, `aws` and `az` were not used because they need an API server or an account.

## What the commands print (expected)

```text evidence="expected"
$ pso deploy:init --target kubernetes --registry registry.example.com/pso --tag 1.2.3
created    deploy/kubernetes/gateway.yaml
created    deploy/kubernetes/orders.yaml
created    deploy/kubernetes/namespace.yaml
created    deploy/kubernetes/config.example.yaml
Nothing was applied anywhere. Replace the CHANGE_ME values, then run `pso deploy:validate --target kubernetes`.

$ pso deploy:validate
OK  11 descriptor file(s) in kubernetes, ecs, container-apps, cloud-run
  WARNING deploy/kubernetes/config.example.yaml [placeholder] 3 CHANGE_ME value(s) must be filled in before this can be deployed
  ...
Static validation only: no cloud account was contacted and nothing was deployed.
```

(The file list is abridged and the example used two services; `deploy:validate` reports `OK` while only placeholder warnings remain, and `--strict` turns those warnings into a failure.) A policy violation is an error and exit code 1: for example an edit that changes `readOnlyRootFilesystem` to `false`, or an image tagged `latest`, is reported by rule name (the test suite exercises ten violation classes).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `--tag must be a fixed version, not 'latest'` | pass a real version |
| a conflict for an existing file | you edited it; `--force` overwrites (commit first) |
| `[placeholder] N CHANGE_ME value(s)` | fill them in; `--strict` fails until you do |
| `inline-secret` | a secret value is written in the file: reference a secret store |

## Common mistakes

- Applying a descriptor with `CHANGE_ME` values still in it.
- Assuming validation means a cluster accepted it: no cluster was contacted.
- Publishing the generated services without a network policy or ingress with TLS.

## Next steps

- [Docker](/devops/docker)
- [Production security checklist](/security/checklist)
