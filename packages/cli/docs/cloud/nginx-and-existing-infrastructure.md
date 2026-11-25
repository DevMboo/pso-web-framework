---
title: nginx and existing infrastructure
description: How PSO manages nginx virtual hosts without touching anything it does not own, how provisioning splits unprivileged steps from administrator steps, and how to adopt a server that already runs things.
order: 10
status: implemented
keywords: [nginx, sites-available, sites-enabled, conf.d, reverse proxy, provisioning, sudo, adoption, hosts, tls]
related: [cloud/environments, cloud/deploy-a-release, cloud/credentials-and-security, cloud/troubleshooting]
---
PSO adopts servers that already run applications. It manages only what it can prove it owns, and it tells you everything else it noticed.

## Ownership

A file is *PSO-managed* when its name is `pso-<application>.conf` **and** its first line is `# Managed by PSO Web (app=<application>)`. Anything else is external:

- an existing vhost is listed by `environment:inspect` but never edited;
- a planned file whose name exists without the marker, or with another application's marker, is a **conflict** and blocks the plan;
- a planned `server_name` plus port that an external vhost already serves is a conflict as well.

```bash
pso environment:inspect production
pso release:plan production
```

## Layouts

| `nginxLayout` (server policy) | Files |
|---|---|
| `pso.d` (default) | `/etc/nginx/pso.d/pso-<app>.conf`, a directory owned by the agent's user |
| `sites` | `/etc/nginx/sites-available/pso-<app>.conf` plus a symlink in `sites-enabled/` |
| `conf.d` | `/etc/nginx/conf.d/pso-<app>.conf` |
| an absolute directory | `<dir>/pso-<app>.conf` |

The declaration can name a different `layout`. Each file holds the upstreams, a loopback listener per service (the stable internal address, see [Deploy a release](/cloud/deploy-a-release)) and, for routed services, the public server with WebSocket forwarding and optional TLS from certificate **file paths you provide**. PSO does not obtain certificates and does not touch DNS.

## Every change is validated

Back up the previous file, write the new one, run `nginx -t`, and only then reload gracefully. If the test fails the previous file is restored and nginx is **not reloaded**, so the running configuration stays the last valid one. If the reload itself fails, the files are restored and a reload is attempted again. Old workers finish their in-flight requests; nothing is stopped.

## Least privilege: provisioning is a plan, not a surprise

The agent runs unprivileged. The few things that need root are listed by `environment:plan`, together with a script you can read and run yourself:

```bash
pso environment:plan production
pso environment:provision production --yes
```

`provision --yes` performs only the steps marked *agent* (directories in the agent's own home, a default policy). The *administrator* steps are creating `/etc/nginx/pso.d` for the agent's user, one `include` line in `nginx.conf` (PSO never edits it), and a sudoers rule granting exactly `nginx -t` and `nginx -s reload`. PSO never installs operating-system packages, changes firewall rules, replaces an existing nginx configuration or restarts unrelated services. Everything is idempotent: running it again converges and removes nothing.

## Paths and links are checked, not trusted

A custom `layout` in a declaration must be an absolute path with no `.` or `..` segments inside the directories PSO may manage (the server's PSO directory, `sites-available`/`sites-enabled`, `conf.d`, `http.d`); anything else, such as `/etc/nginx/../../tmp`, is refused when the plan is made. Before writing, PSO resolves the real location: a symlinked directory that leads outside those roots, or a target file that is itself a symbolic link, is refused (nothing behind the link is touched). An existing `sites-enabled` entry must be the symbolic link to **PSO's own** file; a regular file or a link elsewhere belongs to someone else and stops the change. Concurrent changes are serialized by a lock shared by every deployment on the server, and a failed validation or reload restores the previous files and nginx keeps serving. Verified on Linux (`nginx-safety.test.ts`, run in a Linux container) and in the container end-to-end runs.

## `/etc/hosts` and DNS

Local host resolution (`/etc/hosts`) and public DNS are different things, and PSO changes neither automatically. To test a domain before DNS exists, send the `Host` header yourself (`curl -H "Host: shop.example.com" http://203.0.113.10/`).

## Management is never published

The agent has no network endpoint, so there is nothing for nginx to publish, and no generated configuration mentions it. PSO adds no ports to Docker and no firewall rules.

## What can go wrong

- *`nginx -t fails on the CURRENT configuration`*: PSO refuses to modify a proxy it cannot validate. Fix the existing configuration first.
- *`/etc/nginx/pso.d is missing or not writable`*: run the administrator script from `environment:plan`.
- *The agent cannot run `nginx -t`*: the sudo rule is missing or names a different path to the nginx binary.
- Other software may also listen on the ports you pick; PSO checks ports only against what it can see and against its own reservations.
