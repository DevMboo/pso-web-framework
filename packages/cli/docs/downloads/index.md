---
title: Downloads
description: Download PSO Web V2 (0.2.0-rc.3) for Windows x64 - the recommended portable ZIP and the experimental installer - verify them, install, update and roll back; earlier releases are listed as historical.
order: 1
status: partial
keywords: [downloads, PSO Web V2, 0.2.0-rc.3, portable, installer, Windows x64, checksum, SHA-256, Ed25519, update, rollback]
related: [getting-started/installation, getting-started/requirements, infrastructure/release-integrity-and-signing, reference/migration]
---

**PSO Web — Cloud Ecosystem Framework**

**One ecosystem. Independent teams. Unified architecture.**

PSO Web Framework is free and open-source software, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). It has no telemetry, license check or paid tier ([privacy policy](/downloads/privacy-policy)). The maintainer is [DevMboo](https://github.com/DevMboo). The source code is public at [github.com/DevMboo/pso-web-framework](https://github.com/DevMboo/pso-web-framework).

> [!NOTE]
> **The current release is PSO Web V2, `0.2.0-rc.3`** (release candidate, private prerelease). It is the release this documentation
> describes: the official application structures, the reference Product CRUD, the infrastructure engine and the layered Java event
> and Channels generators. The CLI reports version `0.2.0`; its Java libraries are `com.pso:*:0.2.0-rc.3` and are included.

## Download PSO Web V2 (0.2.0-rc.3)

| Release detail | Value |
| --- | --- |
| Release | [`v0.2.0-rc.3`](https://github.com/DevMboo/pso-web-releases/releases/tag/v0.2.0-rc.3) (prerelease) |
| Platform | Windows 10/11 x64 |
| Recommended asset | `PSO-Web-0.2.0-rc.3-win-x64-portable.zip`, 50.4 MB (50,408,660 bytes) |
| Experimental asset | `PSO-Web-0.2.0-rc.3-win-x64.exe`, 31.4 MB (31,375,245 bytes) |
| Node.js requirement | Bundled private runtime; no system Node.js installation |
| Java | JDK 21 or newer for Spring services; the matching `com.pso` Maven repository is included (`pso java:install`) |
| Access | GitHub sign-in and access to `DevMboo/pso-web-releases` |
| Security | Unsigned developer distribution: no Authenticode signature, development signing key, no independent publisher authentication |

:::download-button url="https://github.com/DevMboo/pso-web-releases/releases/download/v0.2.0-rc.3/PSO-Web-0.2.0-rc.3-win-x64-portable.zip" label="Download PSO Web V2 — Windows x64 portable (0.2.0-rc.3, recommended)"

The **portable ZIP is the recommended download**: the exact ZIP passed 21/21 portable validation checks in an isolated Windows folder
without Node.js on PATH (extraction, launcher, doctor, integrity, repair, relocation, update signer rejection). It installs nothing:
extract it and run `pso.cmd` ([Installation](/getting-started/installation)).

:::download-button url="https://github.com/DevMboo/pso-web-releases/releases/download/v0.2.0-rc.3/PSO-Web-0.2.0-rc.3-win-x64.exe" label="Download the experimental Windows x64 installer (0.2.0-rc.3)"

The **installer is experimental**: it carries the same content, but its real Windows installation flow (wizard, PATH entry,
uninstaller) has not been validated end to end, because Smart App Control on the validation machine refuses unsigned installers. It
may block it on your machine too; it is not a supported installation method yet. Read `INSTALL.md` on the release page first.

The [release page](https://github.com/DevMboo/pso-web-releases/releases/tag/v0.2.0-rc.3) also holds `PORTABLE.md`, `INSTALL.md`,
the checksums, the detached signature, the public key, the release manifest, both SBOMs and the notices. The public website does not
proxy private assets or contain GitHub credentials.

## Verify before use

Download `SHA256SUMS`, `SHA256SUMS.sig` and `release-signing-key.public.pem` from the same release, then compare:

```powershell
Get-FileHash .\PSO-Web-0.2.0-rc.3-win-x64-portable.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

| File | SHA-256 |
| --- | --- |
| `PSO-Web-0.2.0-rc.3-win-x64-portable.zip` | `77eb495bd93a74c22f65c5af8692a535417f5939d95759dfbd9880d6ffca57d0` |
| `PSO-Web-0.2.0-rc.3-win-x64.exe` | `8c572191e145dc8263917ec161f04c234365304129e0ce379fb05fd709746fb1` |

`SHA256SUMS` is signed with Ed25519 by the development key `7ebced006968027b3ca9939c1e245637ce93ba8bb6261a125a0fd31f957dcc89`
(fingerprint of `release-signing-key.public.pem`). The signature proves integrity relative to that key. Because the key travels with
the release, it does **not** independently establish the publisher's identity: confirm the fingerprint through another channel
before using it as an identity claim. Stop if a checksum or the signature differs.

## Code signing policy

No PSO Web release is Authenticode-signed yet. The [code signing policy](/downloads/code-signing-policy) describes how signed releases
will be built, approved and verified, and who is responsible for them; the [privacy policy](/downloads/privacy-policy) states what PSO Web
transfers over the network (nothing unless you ask for it).

## Install, update and roll back

- **New installation:** extract the ZIP into a writable folder (for example `C:\Tools\pso`), run `.\pso.cmd --version` and
  `.\pso.cmd doctor`, and optionally add its `bin` directory to your user PATH. Then `pso java:install` for Spring services. See
  [Installation](/getting-started/installation).
- **Update an existing portable installation** that trusts the same key: `pso update install --package <extracted-zip>\.pso-install\packages\0.2.0-rc.3.psopkg`,
  then `pso integrity check --full` and `pso java:install`. The previous version is kept side by side.
- **Roll back:** `pso update rollback` returns to the previous version. Workspaces live outside the installation and are not touched
  by an update, a rollback or removal of the folder; migrate them separately ([migration](/reference/migration)).

Do not disable or bypass Smart App Control, SmartScreen, Defender or organizational policy. If your system blocks the files, ask
your administrator or wait for a signed release. See [Release integrity and signing](/infrastructure/release-integrity-and-signing).

## Troubleshooting a download

| Symptom | Cause | Fix |
| --- | --- | --- |
| the download button answers `404` | you are not signed in to GitHub, or your account has no access to the private `DevMboo/pso-web-releases` | sign in with an account that has access; the website never holds credentials |
| the SHA-256 differs from the table above | an incomplete or altered download | delete the file and download it again from the release page; never run a file whose hash differs |
| Windows blocks the installer ("An Application Control policy blocked this file") | Smart App Control or another policy refuses unsigned files | use the portable ZIP, or ask your administrator; do not switch the protection off |
| `pso update install` refuses the package | the installation trusts another signing key | that is the protection working: extract the ZIP into a new folder instead |

## Previous releases (historical)

Earlier releases stay available, unchanged, for compatibility and rollback; they are not recommended for new work and describe the
0.1 framework.

| Release | Asset | Status |
| --- | --- | --- |
| [`v0.1.0-alpha.2`](https://github.com/DevMboo/pso-web-releases/releases/tag/v0.1.0-alpha.2) | `PSO-Web-0.1.0-alpha.2-win-x64-portable.zip` (SHA-256 `094b4cd555fd837d46688d45f82b9805b8c8c73667c6f63dc172f4f9c4c45dbe`) | 0.1 portable developer preview |
| `v0.1.0-alpha.1` | 0.1 installer encrypted for one validation recipient | not a general installation path |
