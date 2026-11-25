---
title: Code signing policy
description: How PSO Web release executables are to be Authenticode-signed - current status (not signed yet), what is and is not signed, verifiable builds, manual approval of every signing request, team roles and the privacy policy.
order: 2
keywords: [code signing policy, Authenticode, SignPath, signing, approval, roles, installer, uninstaller, verifiable build]
related: [downloads/privacy-policy, downloads/index, infrastructure/release-integrity-and-signing]
---

> [!IMPORTANT]
> **Status: no PSO Web release is Authenticode-signed yet.** The project is preparing an application to the
> [SignPath Foundation](https://signpath.org) free code-signing program for open-source projects. It has **not** been accepted, no
> certificate has been issued, and nothing is signed through SignPath. `0.2.0-rc.6` is unsigned; Windows Smart App Control can block its
> installer. This page describes the policy that signed releases will follow, and it will name the signing service once one is active.

## What will be signed

| File | Signing |
|---|---|
| the installer `PSO-Web-<version>-win-x64.exe` | signed by the project's code-signing certificate |
| its uninstaller `unins000.exe`, which is also the temporary copy of Setup that runs from TEMP | signed by the same certificate, before it is embedded in the installer |
| the bundled Node.js runtime `node.exe` | **not** re-signed: it keeps the OpenJS Foundation's own signature, which the build verifies |
| scripts (`pso.cmd`, the Maven wrapper of generated projects) and JavaScript | cannot carry Authenticode signatures; covered by the package's signed per-file inventory (`pso integrity check --full`) |

Only executables built from this project's own source code (Apache License 2.0) are signed. Upstream binaries are never signed with the project's certificate.
Every signed file carries the product name **PSO Web** and the release version (for example `0.2.0-rc.6`, numerically `0.2.0.0`) in its
version information, the same values in every file of a release. Signatures use SHA-256 and an RFC 3161 timestamp.

## How a release is built and approved

1. A release is built by GitHub Actions on GitHub-hosted runners from a tagged commit of the public source repository ([github.com/DevMboo/pso-web-framework](https://github.com/DevMboo/pso-web-framework)). Build scripts and
   CI configuration are part of that repository. No artifact built on a developer's machine is submitted for signing.
2. The build submits each artifact to the signing service by its GitHub artifact identifier, so the service can verify that it was built
   by that workflow from that commit.
3. **Every signing request is approved manually** by a signing approver, twice per release (uninstaller, then installer). The GitHub
   environment of the release job also requires an approver before the job runs.
4. The build then checks that the signed installer is exactly the submitted build plus its signature, and that Windows trusts the
   signature. Only after that are checksums and manifests written.
5. Publishing a release is a separate, manual step.

## Team roles

| Role | Responsibility | Members |
|---|---|---|
| Committers (authors) | may change the source code without an additional review | [DevMboo](https://github.com/DevMboo) |
| Reviewers | review every change proposed by someone who is not a committer (pull requests) before it is merged | [DevMboo](https://github.com/DevMboo) |
| Approvers | decide whether a release may be signed, and approve each signing request | [DevMboo](https://github.com/DevMboo) |

All members use multi-factor authentication for the source repository and for the signing service. The team is responsible for the
source code repository, the build scripts and every released artifact.

## Privacy

See the [privacy policy](/downloads/privacy-policy): PSO Web transfers no information to other networked systems unless specifically
requested by the user or the person installing or operating it.

## What can go wrong

- **A file signed by this project behaves maliciously or is misused:** report it with proof to the project (an issue in the source
  repository) so the team can investigate; the signing service can revoke the certificate.
- **A signed file does not match the source:** every signed release is reproducible from its tag by the published workflow; report any
  difference.
- **Windows still warns about a signed release:** a new certificate can need time to build reputation with Microsoft SmartScreen and
  Smart App Control. Never switch Windows protection off; use the portable ZIP or wait.
