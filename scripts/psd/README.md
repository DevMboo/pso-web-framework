# PSD: PSO Secure Distribution (maintainer tooling)

Not part of any distributed artifact: these files name the indicators they search for, and the keys and deny-list they use must stay outside the repository.

## One-time setup (maintainer machine)

```text
node packages/cli/bin/pso.js dist keygen --kind signing --out C:\Users\<you>\.pso-psd\keys --name release   # keep release.private.pem offline / protected
# private deny-list of internal indicators (hosts, IPs, user names, tenant ids), one per line: C:\Users\<you>\.pso-psd\denylist.txt
# optional, for the selective obfuscation profile (never installed in the repository):
mkdir %USERPROFILE%\.pso-psd\tools && cd %USERPROFILE%\.pso-psd\tools && npm init -y && npm install javascript-obfuscator@5.10.1 --save-exact
```

## Authorizing a developer

1. The developer runs `node pso-recipient.mjs init --label "<name>"` on their machine and sends the `.enrollment.json` file (public key only).
2. The developer reads the fingerprint to you over a different channel. Compare it with `fingerprint` in the file.
3. Save the public key as `<recipients dir>\<name>.public.pem` (the `publicKeyPem` field of the enrollment file).
4. Rebuild the release (below). To **remove** a developer, delete their `.public.pem` and rebuild: future releases are not encrypted for them; earlier ones stay readable to them.

## Building a candidate

```text
npm run build                                   # compiled output, agent bundle, diagnostic codes
node scripts/release-maven.mjs --out release-out\maven      # compiled Java artifacts, no sources, scanned (needs Maven/JDK; minutes)
node scripts/psd/build-release.mjs --label 0.1.0-alpha.1 \
     --signing-key C:\Users\<you>\.pso-psd\keys\release.private.pem \
     --recipients C:\Users\<you>\.pso-psd\recipients \
     --maven release-out\maven\repository --obfuscate
```

Every stage prints PASSED / FAILED. A failed mandatory stage stops the build and no public release directory is produced. A candidate is never "approved" by its own build.

Outputs: the public release directory `release-out\psd\<label>\` (only approved files) and internal evidence in `docs\implementation\evidence\psd\<label>\` (never distributed).

## Build modes

| Mode | Flags | Authenticode | Release gate |
|---|---|---|---|
| **Production** | `--publisher "<certificate common name>"` (+ `--recipients` for an encrypted private release, or `--runtime --runtime-license` for an unencrypted one) | installer and uninstaller signed by the publisher, SHA-256, RFC 3161 timestamp | enforced: the build stops on any unsigned, untrusted, untimestamped or foreign-signed required executable |
| Unsigned development alpha | `--dev-alpha --runtime <node.exe> --runtime-license <file>` | none (labelled "Unsigned Developer Alpha") | NOT RUN, reported as such |
| Unsigned encrypted development build | `--unsigned-development --recipients <dir>` | none (labelled "Unsigned development build") | NOT RUN, reported as such |

A build with neither a publisher nor an unsigned-development flag is refused: there is no silent unsigned default.

## Authenticode signing (production)

The certificate is provisioned **outside the repository**. A publicly trusted code-signing key has had to live in hardware (token, HSM or cloud
HSM) since June 2023, so the supported identities are the certificate store (which also covers hardware tokens and cloud KSPs), SignTool
digest libraries for cloud signing, and a `.pfx` for test certificates only. Configure exactly one, in the environment of the build:

```text
PSO_SIGN_THUMBPRINT=<40-hex SHA-1 thumbprint>      certificate store; [PSO_SIGN_STORE=My] [PSO_SIGN_MACHINE_STORE=1]
                                                   [PSO_SIGN_CSP=<provider> PSO_SIGN_KEY_CONTAINER=<container>] for a token not mapped to the store
PSO_SIGN_DLIB=<dlib.dll> PSO_SIGN_DLIB_METADATA=<metadata.json>   Azure Artifact Signing (Trusted Signing) or a vendor's SignTool dlib
PSO_SIGN_PFX=<file> PSO_SIGN_PFX_PASSWORD=<from a secret store>   test certificates only
PSO_TIMESTAMP_URL=<RFC 3161 TSA>                   default http://timestamp.acs.microsoft.com
PSO_SIGNTOOL=<signtool.exe>                        default: the newest Windows SDK (x64)
```

```text
node scripts/psd/codesign.mjs check                # READY, or BLOCKED (exit 3) with what is missing; signs nothing
node scripts/psd/build-release.mjs --label <v> --signing-key <ed25519 pem> --publisher "<CN>" ^
     --runtime C:\Users\<you>\.pso-psd\runtime\node.exe --runtime-license C:\Users\<you>\.pso-psd\runtime\LICENSE-node.txt --maven <repo>
node scripts/psd/build-portable.mjs --label <v> --work <work> --runtime <node.exe> --runtime-license <file> --release <dir> --signing-key <pem> --publisher "<CN>"
```

Order, and why: the configuration, SignTool and the bundled runtime's own signature are checked **before** anything is built or removed.
Inno Setup then runs `codesign.mjs sign` (its `SignTool=` and `SignedUninstaller=yes`) on the uninstaller and on Setup's temporary
self-copies while compiling, and on the finished installer; Inno itself refuses a file that comes back unsigned. (Signing the finished
executable afterwards would leave those copies unsigned: Smart App Control blocks exactly them, Code Integrity event 3077.) Each signature is verified with `signtool verify /pa` and WinVerifyTrust and
logged. The **release gate** then inspects every executable (ZIP contents included): PSO-owned files must be signed by the publisher,
trusted by Windows and timestamped; third-party files (`node.exe`) must keep their own publisher's signature (never re-signed). Only after
that are the installer manifest, `release-manifest.json` and `SHA256SUMS` computed, and the gate checks that `SHA256SUMS` records the
verified signed installer. The `.psopkg` contains no PSO-owned executable; its Ed25519 signature and per-file inventory, and every update,
repair and integrity check, are unchanged.

Scripts (`pso.cmd`, `mvnw.cmd`) cannot carry Authenticode signatures; they are covered by the package's per-file integrity.

## Validating a signed release with Smart App Control

On a **disposable Windows 11 virtual machine** with Smart App Control **On** (never a developer's or a consumer's machine; nothing is
changed in Smart App Control, no certificate or root is installed):

```text
node scripts/psd/validate/signed-sac.mjs --isolated --installer <PSO-Web-<v>-win-x64.exe> --release <release dir> --publisher "<CN>" ^
     [--update-package <newer .psopkg signed by the same key>] [--evidence <dir>]
```

It refuses to run (exit 3) without `--isolated`, when Smart App Control is not On, or when PSO is already installed. It checks the signed
checksums and the installer signature, installs silently, verifies every installed executable (signed uninstaller, OpenJS-signed runtime),
runs `--version`, `doctor`, `integrity`, repair, update and rollback, uninstalls, and fails on any Code Integrity block or audit event
(3033, 3034, 3076, 3077) that names a PSO file.

## Parts

| File | Role |
|---|---|
| `policy.mjs` | the file classification; an unknown file fails the build |
| `codesign.mjs` | Authenticode signing with SignTool (identity providers, SHA-256, RFC 3161), verification and the production release gate |
| `validate/signed-sac.mjs` | the Windows 11 Smart App Control validation of a signed release (isolated machine only) |
| `stage.mjs` | isolated staging from `dist.config.json` with an optional protected-build overlay |
| `scan.mjs` | recursive redacted scanner (`node scripts/psd/scan.mjs <dir|file> --denylist <file> --exceptions scripts/psd/exceptions.json`) |
| `protect.mjs` | JavaScript protection profiles, agent bundle, pruned third-party packages |
| `build-tools.mjs`, `tools/` | `pso-bootstrap.mjs` and `pso-recipient.mjs` |
| `differential.mjs` | the same scripted workflow through two CLIs; outputs and generated trees must match |
| `build-release.mjs` | the pipeline |
| `test/` | `node --test scripts/psd/test/*.test.mjs` |
