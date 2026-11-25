---
title: Credentials and the security model
description: Where every secret lives, which guarantees PSO gives, and the limits of each mechanism, written so you can decide what to trust.
order: 9
status: implemented
keywords: [credentials, keyring, credential manager, secret service, encrypted file, rotation, revocation, audit, threat model]
related: [cloud/connect-a-server, cloud/agent-and-enrollment, cloud/pipelines-and-policy, security/security-configuration]
---
This page states what PSO protects and, equally, what it does not.

## Where secrets live

| Secret | Where | Never in |
|---|---|---|
| SSH password or key passphrase | your protected credential store (opaque reference in `~/.pso-cloud/connections.json`) | declarations, git, logs, argv, manifests |
| SSH private key | its own file, used in place | copied or imported anywhere |
| Your client key for the agent | your credential store | the server (it holds only the public key) |
| The agent's identity key | the server, mode 600, never leaves | any response, log or export |
| Application secrets | the server's `secrets/` directory, mode 600, injected as environment variables | plans, manifests, deployment history, the audit log |
| Git deploy key or token | a server secret named by `source.credentials`; reaches git through its environment | repository URLs, argv, logs |

## The credential store

PSO uses the operating system when it can: **Windows Credential Manager** (`windows-credential-manager`), the **Linux Secret Service** through `secret-tool`, the **macOS Keychain**. Secrets are passed on standard input, not on a command line. Where none is available you choose `PSO_CREDENTIAL_PROVIDER=encrypted-file`, which uses AES-256-GCM with a key derived by scrypt from `PSO_CREDENTIAL_PASSPHRASE` or a key file (`PSO_CREDENTIAL_KEYFILE`, at least 32 bytes, owner-only). **There is no silent fallback to plain text.** If nothing is available PSO fails with instructions.

| Mechanism | Status |
|---|---|
| Windows Credential Manager | **exercised** on Windows (store, read, replace, remove, no secret in arguments) |
| Encrypted file (AES-256-GCM + scrypt) | **exercised** (wrong passphrase and tampering are refused) |
| Linux Secret Service (`secret-tool`) | written, **not run**: this was not exercised on a Linux desktop session |
| macOS Keychain | written, **not run** on macOS |
| SSH agent (`--auth agent`) | **exercised** against a real server with a running `ssh-agent`: PSO stores no key path or key, and when the agent no longer holds the key the connection **fails** (no fallback to another credential) |
| Passphrase-protected SSH key, password login | **exercised** (the secret reaches `ssh` through the askpass helper below) |
| Git repository credentials | a server secret named by `source.credentials` (a deploy key or token); it reaches git through its environment (an ssh key file in a private temporary directory, or an HTTP header from the environment), never the URL or argv |

**The askpass helper.** For a password or key passphrase PSO creates, per `ssh` child, a temporary directory (mode 700) with a tiny launcher (mode 700/600) and removes it when that child ends. The launcher contains **no secret**: the value is placed only in the child's environment (`PSO_SSH_SECRET`). Verified on Windows and Linux: no file contains the secret, permissions are owner-only, cleanup removes the directory and is idempotent. Residual: on Linux another process of the same user can read a live process's environment.

Isolation, rotation and removal: every connection has its own credential references and an environment never reads another's; `pso connection:rotate` replaces them (the old ones are deleted), `pso connection:revoke` deletes them and ends the client's access on the server, and `pso signer:remove` deletes a signing key from the machine. Studio's renderer never receives a secret: values typed there go to the local Studio process once.

Studio keeps the credential store in its own process. A password you type into Studio goes to that process once, is stored, and is never sent back to the page.

## Rotation, revocation, removal

```bash
pso connection:rotate prod              # new client key enrolled, old one revoked and deleted
pso connection:rotate prod --ssh-secret # replace the stored SSH password or passphrase
pso connection:revoke prod --yes        # end access on the server, delete local secrets
pso connection:remove prod --yes        # forget the connection on this machine only
```

## What PSO redacts

Every log line, error, response and exported record passes through a redactor: registered secret values, credential-shaped keys, bearer headers, PEM private keys, URL user-info and common token shapes. When logs are read back through PSO, all secrets stored on the server are masked too.

## Guarantees and limits

- A native credential store protects against other users and a stolen disk. It does **not** protect against malware running as you: that code can ask the same store.
- The `encrypted-file` provider is exactly as strong as its passphrase or key file.
- Passing a password to `ssh` uses a one-process askpass helper and the child's environment; on Linux another process of the **same user** could read it from `/proc` while that process lives.
- A request signature protects the channel's integrity and prevents replay. It is not end-to-end encryption; SSH provides the confidentiality.
- The audit log is hash-chained and sanitized: edits and accidents are detectable (`pso release:audit production --verify`). A fully privileged administrator of the server can rewrite the entire chain; ship the head hash somewhere they do not control if that matters to you.
- An application that prints its own secret in an unrecognisable form writes it into its own log file; PSO can only mask what it knows or recognizes.
- None of this is a claim that the system cannot be compromised, and no custom cryptography is used: only Ed25519, SHA-256, AES-256-GCM and scrypt from the Node.js runtime.

## What can go wrong

Losing the credential store loses your enrolled client key; an administrator can invite you again. If the encrypted-file passphrase is lost the file cannot be recovered; enroll again.
