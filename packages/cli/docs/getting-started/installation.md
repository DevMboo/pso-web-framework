---
title: Installation
description: Use the portable Windows distribution or a checkout of the framework's source (Apache License 2.0), install matching Java dependencies, verify files, update and roll back.
order: 5
status: partial
keywords: [install, portable, Windows, Java, java:install, npm link, update, repair, rollback]
prerequisites: ["Windows 10/11 x64 for the portable build; Node.js 24 for a source checkout", "JDK 21 or newer for Spring services"]
related: [downloads/index, getting-started/requirements, spring/maven-bom, infrastructure/release-integrity-and-signing]
---

> [!NOTE]
> The current release is **PSO Web V2, `0.2.0-rc.7`**; its CLI reports version `0.2.0`. Download it from [Downloads](/downloads/index) (the public release [`v0.2.0-rc.7`](https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.7); its Windows files are **not Authenticode-signed**). The 0.1 alpha releases listed there are historical: do not substitute their files for rc.7.

## Option 1: the portable Windows distribution (recommended)

The portable ZIP is the supported form for the current release candidate while the Windows installer is unsigned and unvalidated end to end. It needs Windows 10/11 x64, but bundles a private Node.js runtime: you do **not** install Node.js system-wide. Download `PSO-Web-0.2.0-rc.7-win-x64-portable.zip` and its `SHA256SUMS`, `SHA256SUMS.sig` and `release-signing-key.public.pem` from the [release page](https://github.com/DevMboo/pso-web-releases/releases/tag/v0.2.0-rc.7). Confirm the ZIP's SHA-256 (`77eb495bd93a74c22f65c5af8692a535417f5939d95759dfbd9880d6ffca57d0`) before extraction; see [Downloads](/downloads/index) for verification and security limits. The experimental installer `PSO-Web-0.2.0-rc.7-win-x64.exe` carries the same content but is not validated end to end.

1. Extract to a writable folder such as `%LOCALAPPDATA%\PSO` or `C:\Tools\pso`. Avoid `Program Files`; no administrator rights are needed.
2. Run `pso.cmd` from the extracted folder and check the installation:

   ```powershell
   .\pso.cmd --version
   .\pso.cmd doctor
   .\pso.cmd integrity check --full
   ```

3. Optionally add that folder's `bin` directory to your **user** PATH, open a new terminal, and check `Get-Command pso -All`. A development `npm link` can otherwise take precedence over the installed command.

The ZIP writes no registry entries and does not alter a system Node.js installation. The bundled `node.exe` is Authenticode-signed by the OpenJS Foundation; the PSO ZIP and scripts are **not** publisher-authenticated. Do not disable or bypass Windows or organizational application-control protections. See [Release integrity and signing](/infrastructure/release-integrity-and-signing).

### Matching Java artifacts

For generated Spring services, use JDK 21 or newer and run `pso java:install`. The installed rc.7 distribution contains its matching Maven file repository and generates services that request `com.pso:*:0.2.0-rc.7`; `java:install` copies those artifacts into your local Maven repository. It does not publish them to Maven Central. Then build a generated service with its Maven Wrapper:

```powershell
pso java:install
cd .\catalog
.\mvnw.cmd test
```

If your distribution provides the Maven file repository separately, use `pso java:install --from <maven-repository-dir>`. The source-checkout workflow below uses its own Java version; do not mix its SNAPSHOT artifacts with a release candidate. See [Maven BOM and versions](/spring/maven-bom).

### Maintain and update

Run maintenance commands from the installed CLI, with `--root <folder>` when you are managing another installation root:

```powershell
pso integrity check --full
pso repair --full
pso update install --package <authorized-newer.psopkg>
pso update rollback
```

`integrity check` is read-only. Repair restores the installed version from its authenticated package. Update verifies a newer signed package and keeps the prior version for rollback; it does not fetch an unreleased candidate or change your workspaces. If an update changes the Java artifacts, run `pso java:install` for the newly active release. A package signed by another key is refused. See [Version migration](/reference/migration) before adopting new project structure or infrastructure features.

## Option 2: a framework checkout

For framework development, install Node.js 24 or newer and build the checkout. The `@pso/*` npm packages are not published; `npm link` points to the checkout, and moving it breaks the command:

```powershell
cd path\to\pso-web-framework
npm install
npm run build
cd packages\cli
npm link
pso doctor
```

Alternatively run `node path/to/pso-web-framework/packages/cli/bin/pso.js` without linking. A checkout also has `pso-java/`; there `pso java:install` builds and installs its `0.1.0-SNAPSHOT` artifacts, which are distinct from the installed rc.7 artifacts. Rebuild the checkout after source changes, and remove the global link with `npm unlink -g @pso/cli` when finished. [Installed versus development CLI](/devops/installed-and-development-cli) explains how to identify which `pso` is running.

## Start a workspace

```powershell
pso create workspace shop
cd shop
pso create service catalog
pso create orchestrator gateway
pso validate
```

New projects use the [layered Java service](/architecture/java-microservice) and [modular TypeScript orchestrator](/architecture/typescript-orchestrator), with a functional Product CRUD example. Add `--template empty` to a `create service` or `create orchestrator` command for the same structure without the example. Existing 0.1 projects keep their legacy structure; use [Structure compatibility and migration](/architecture/structure-migration) to plan any change.

## Troubleshooting the installation

| What you see | Meaning | What to do |
|---|---|---|
| Windows blocks the extracted `pso.cmd` or a file of the ZIP (application control, Smart App Control) | the files are not publisher-signed | use only an authorized copy with a matching `SHA256SUMS`; never disable or bypass the protection |
| `Get-Command pso -All` lists a development link first | an `npm link` of a checkout shadows the installed command | remove it (`npm unlink -g @pso/cli`) or call the installed `pso.cmd` by its full path |
| `Non-resolvable import POM: com.pso:pso-bom` in a generated service | the matching Java artifacts are not in the local Maven repository | `pso java:install` with the installed distribution |
| `does not carry com.pso:*:0.2.0-rc.7` from `pso java:install --from` | the repository is from another release | use the Maven repository of the same distribution |
| `integrity check` reports changed files | a file of the installation was modified or damaged | `pso repair --full`, or `pso update rollback` after a failed update |
