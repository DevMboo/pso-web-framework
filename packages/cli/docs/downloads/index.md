---
title: Downloads
description: Download PSO Web V2 (0.2.0-rc.6) for Windows x64 - the recommended portable ZIP and the experimental, Authenticode-unsigned installer - verify them, install, update and roll back.
order: 1
status: partial
keywords: [downloads, PSO Web V2, 0.2.0-rc.6, portable, installer, Windows x64, checksum, SHA-256, Ed25519, update, rollback]
related: [getting-started/installation, getting-started/requirements, infrastructure/release-integrity-and-signing, reference/migration]
---

**PSO Web — Cloud Ecosystem Framework**

**One ecosystem. Independent teams. Unified architecture.**

PSO Web Framework is free and open-source software, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). It has no telemetry, license check or paid tier ([privacy policy](/downloads/privacy-policy)). The maintainer is [DevMboo](https://github.com/DevMboo). The source code is public at [github.com/DevMboo/pso-web-framework](https://github.com/DevMboo/pso-web-framework).

> [!NOTE]
> **The current release is PSO Web V2, `0.2.0-rc.6`** (release candidate, GitHub prerelease of the source repository; `0.2.0-rc.4`
> was the first public release). It is the release this documentation describes: the official application structures, the reference Product CRUD, the
> infrastructure engine, FEI/MEI and the cloud engine. The CLI reports version `0.2.0`; its Java libraries are `com.pso:*:0.2.0-rc.6`
> and are included.

> [!WARNING]
> **The Windows installer and the portable ZIP are NOT Authenticode-signed.** This is a release candidate published by the maintainer
> without a code-signing certificate; it is not a SignPath-signed production release. Windows Smart App Control or SmartScreen may
> block the installer. Never disable those protections: use the portable ZIP, or wait for a signed release.

## Download PSO Web V2 (0.2.0-rc.6)

| Release detail | Value |
| --- | --- |
| Release | [`v0.2.0-rc.6`](https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.6) (public prerelease, built from commit `d6b20b7` of the source repository) |
| Platform | Windows 10/11 x64 |
| Recommended asset | `PSO-Web-0.2.0-rc.6-win-x64-portable.zip`, 50.5 MB (50,462,355 bytes) |
| Experimental asset | `PSO-Web-0.2.0-rc.6-win-x64.exe`, 31.4 MB (31,398,546 bytes), **Authenticode-unsigned** |
| Also on the release page | the npm tarballs of the 13 `@pso/*` packages (0.2.0) and the `com.pso:*:0.2.0-rc.6` Maven file repository, with their SBOMs |
| Node.js requirement | Bundled private runtime; no system Node.js installation |
| Java | JDK 21 or newer for Spring services; the matching `com.pso` Maven repository is included (`pso java:install`) |
| Access | public: no GitHub account needed |
| Security | No Authenticode signature; `SHA256SUMS` and the package are signed with the project's Ed25519 release key (below) |

:::download-button url="https://github.com/DevMboo/pso-web-framework/releases/download/v0.2.0-rc.6/PSO-Web-0.2.0-rc.6-win-x64-portable.zip" label="Download PSO Web V2 — Windows x64 portable (0.2.0-rc.6, recommended)"

The **portable ZIP is the recommended download**. It installs nothing: extract it and run `pso.cmd`
([Installation](/getting-started/installation)). The exact ZIP passed 21/21 portable validation checks, and the installed rc.6 CLI passed the 35-check integration of `pso frontend:config --env` (two FEIs, Docker, Chrome).

:::download-button url="https://github.com/DevMboo/pso-web-framework/releases/download/v0.2.0-rc.6/PSO-Web-0.2.0-rc.6-win-x64.exe" label="Download the experimental, Authenticode-unsigned Windows x64 installer (0.2.0-rc.6)"

The **installer is experimental and unsigned**: it carries the same content, but its real Windows installation flow (wizard, PATH
entry, uninstaller) has not been validated end to end, because Smart App Control on the validation machine refuses unsigned
installers. It may block it on your machine too. Read `INSTALL.md` on the release page first.

The [release page](https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.6) also holds `PORTABLE.md`, `INSTALL.md`, the checksums, the detached signature, the public key, the
release manifest, the SBOMs and the notices.

## Verify before use

Download `SHA256SUMS`, `SHA256SUMS.sig` and `release-signing-key.public.pem` from the same release, then compare:

```powershell
Get-FileHash .\PSO-Web-0.2.0-rc.6-win-x64-portable.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

| File | SHA-256 |
| --- | --- |
| `PSO-Web-0.2.0-rc.6-win-x64-portable.zip` | `45725978c4094112914f66c04ff63ede8897ca05aad4f657b7e4dcde78a0267b` |
| `PSO-Web-0.2.0-rc.6-win-x64.exe` | `49a9a93429f2770010f48f3ea5f052da8001a98998721ccfdd3a3a6cf054e6a4` |
| `pso-npm-0.2.0-packages.zip` | `13905e506401e446db56da3987dee493e10eeb259cf909c6d84407819ba9918c` |
| `pso-java-0.2.0-rc.6-maven-repository.zip` | `27a954e585e1d261ed706e9c3e4a9a5bf34686f6e24c7f9f0b7cf33ac56f734e` |

The Windows files are listed in `SHA256SUMS` and the package archives in `SHA256SUMS-PACKAGES`, both signed.

 `SHA256SUMS` is signed with Ed25519 by the
release key `7ebced006968027b3ca9939c1e245637ce93ba8bb6261a125a0fd31f957dcc89` (fingerprint of `release-signing-key.public.pem`,
also published in this repository's documentation). The signature proves integrity relative to that key; the key travels with the
release, so confirm the fingerprint here, through a channel other than the download, before relying on it. Stop if a checksum or the
signature differs.

## Code signing policy

No PSO Web release is Authenticode-signed yet, including 0.2.0-rc.6. The [code signing policy](/downloads/code-signing-policy) describes how signed releases
will be built, approved and verified, and who is responsible for them; the [privacy policy](/downloads/privacy-policy) states what PSO Web
transfers over the network (nothing unless you ask for it).

## Install, update and roll back

- **New installation:** extract the ZIP into a writable folder (for example `C:\Tools\pso`), run `.\pso.cmd --version` and
  `.\pso.cmd doctor`, and optionally add its `bin` directory to your user PATH. Then `pso java:install` for Spring services. See
  [Installation](/getting-started/installation).
- **Update an existing portable installation** that trusts the same key: `pso update install --package <extracted-zip>\.pso-install\packages\0.2.0-rc.6.psopkg`,
  then `pso integrity check --full` and `pso java:install`. The previous version is kept side by side.
- **Roll back:** `pso update rollback` returns to the previous version. Workspaces live outside the installation and are not touched
  by an update, a rollback or removal of the folder; migrate them separately ([migration](/reference/migration)).

Do not disable or bypass Smart App Control, SmartScreen, Defender or organizational policy. If your system blocks the files, ask
your administrator or wait for a signed release. See [Release integrity and signing](/infrastructure/release-integrity-and-signing).

## Troubleshooting a download

| Symptom | Cause | Fix |
| --- | --- | --- |
| the download button answers `404` | the asset name changed or the release is not reachable | open the [release page](https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.6) and download from there |
| the SHA-256 differs from `SHA256SUMS` | an incomplete or altered download | delete the file and download it again from the release page; never run a file whose hash differs |
| Windows blocks the installer ("An Application Control policy blocked this file") | Smart App Control or another policy refuses unsigned files | use the portable ZIP, or ask your administrator; do not switch the protection off |
| `pso update install` refuses the package | the installation trusts another signing key | that is the protection working: extract the ZIP into a new folder instead |

## Previous releases (historical)

Earlier releases (rc.1 to rc.3 of 0.2.0 and the 0.1 alphas) were private prereleases in the maintainer's release archive; they are kept
unchanged for rollback but are not public. They are not recommended for new work; the 0.1 alphas describe the 0.1 framework.

| Release | Asset | Status |
| --- | --- | --- |
| `v0.1.0-alpha.2` (private archive) | `PSO-Web-0.1.0-alpha.2-win-x64-portable.zip` (SHA-256 `094b4cd555fd837d46688d45f82b9805b8c8c73667c6f63dc172f4f9c4c45dbe`) | 0.1 portable developer preview |
| `v0.1.0-alpha.1` | 0.1 installer encrypted for one validation recipient | not a general installation path |
