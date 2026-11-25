---
title: Studio Cloud section
description: Manage connections, environments, deployments, pipelines, infrastructure, credentials and audit logs from PSO Studio, with the same engine and policies as the CLI.
order: 11
status: implemented
keywords: [studio, cloud, remote, deployment, pipeline visualization, blue-green, credentials, audit]
related: [devops/studio, cloud/deploy-a-release, cloud/credentials-and-security, cloud/overview]
---
```bash
pso studio --remote
```

Studio normally stays read-only. With `--remote` it gains the **Cloud** section, and only then does it offer any action. Without the flag the section shows your local declarations and connections, says that remote management is off, and offers no button, because a button that cannot work is worse than none.

## One engine, two clients

Studio's local server is the trusted backend: it owns your credential store and your SSH sessions and calls exactly the same operations as the CLI. The browser page receives sanitized data and opaque references, never a secret. A password typed in the *Add connection* form goes to the local process once, into the protected credential store, and is never returned. Mutating requests need the Studio access cookie, a same-origin `Origin` header and a custom header, and each action that changes an environment needs the environment name as confirmation: for **production and staging you must type it**, for the other environments the field is pre-filled.

## Tabs

| Tab | What you can do |
|---|---|
| Overview | See every declared environment with its connection state, and read live status (active, previous and last known-good release, the lock, services running, memory and disk) when you ask for it |
| Environments | Open a declaration with its diagnostics and plan a deployment of a branch, tag or commit |
| Connections | Fetch and approve host keys, add a connection, test every layer, install and enroll the agent |
| Deployments | Follow history, open a deployment live (pipeline stages, the blue-green view, a sanitized log), cancel, roll back or recover |
| Pipelines | See each pipeline's stages and which are off |
| Infrastructure | Read server resources, tools, nginx virtual hosts (PSO-managed versus external) and the provisioning plan with the administrator script |
| Credentials | Rotate or revoke, list who has access and their roles, invite teammates with a single-use token, manage server secret names |
| Signing | Create signing identities on this machine (the private key goes to the credential store and is never shown), see and change the signers an environment trusts, require signed releases, sign a clean checkout, and ask the server to verify a signed manifest (authenticity and integrity shown separately) |
| Applications | The real URLs of each application (read from the nginx file PSO manages), the active release, strategy and runtime, and **Verify accessibility**: process, local health, reverse proxy, reachability from this machine, TLS and an optional authenticated SSH tunnel, each shown on its own |
| Endpoints | The routes published with the active release, complete URLs, required scopes, and a guarded request tester (explicit action, strict TLS, state-changing methods need their own confirmation, the bearer token is never stored) |
| Services | Measured processes, memory, restarts and unit identity of the application, and the infrastructure services of the host listed as *not managed by PSO* |
| NGINX | The nginx files PSO can see (managed or external, effective or not), a guarded editor for PSO-managed files only (lint, preview, `nginx -t`, graceful reload, backup, restore); external files are read-only |
| Network | Every listening socket assessed against the exposure policy, the effective sudo privilege of the agent's user, and a remediation plan that is never applied automatically |
| Audit | The server's hash-chained audit log with chain verification, and the local audit of what you did from this machine |

Production is unmistakable: its name appears as a bordered, uppercase pill with a warning icon, never by color alone, and status is always text plus an icon.

## Pipeline and traffic views

A deployment shows its stages as chips: pending, running, passed, failed, skipped, blocked, awaiting approval, cancelled. The blue-green view shows the previous and candidate releases and which one **currently receives traffic according to the deployment's recorded state**. Both come from the server's deployment file. Nothing is simulated: when live data has not been read, the page says so.

```text evidence="illustrative"
Previous release  r20261114223537-9874ff64   [receiving traffic]   <-->   Candidate release  r20261114223601-ce58a814   [not receiving traffic]
```

## What can go wrong

- *Remote management is disabled*: restart with `pso studio --remote`. The agent's own mode (disabled, development, protected) still applies on top.
- A server that cannot be reached shows an error in the section only; the Studio connection indicator reflects Studio's own server, not the remote one.
- Studio listens on loopback only and requires its one-time URL token; closing the terminal stops it. A deployment you started keeps running on the server.
- The UI cannot weaken policy: an approval requirement, a stale plan or a disabled strategy refuses the action with the same reason the CLI gives.
