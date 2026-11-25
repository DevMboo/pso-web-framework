---
title: Signed packages and installation lifecycle
description: Build a signed (optionally encrypted) .psopkg, compile the Windows installer, install, check integrity, repair, update, roll back and uninstall, and produce npm and Maven release evidence - with the real output of each step and the limits that remain.
order: 9
status: partial
keywords: [recipient, dpapi, bootstrap, psopkg, dist, setup, integrity, repair, uninstall, update, rollback, signing, ed25519, aes-256-gcm, installer, sbom, provenance, release]
related: [devops/build-and-deploy, devops/ci-cd, security/service-identity, devops/cloud-descriptors, getting-started/installation]
---
> [!STATUS]
> Implemented and tested on disposable installation roots: the `.psopkg` format, `setup`, `integrity`, `repair`, `update` (with rollback) and `uninstall`; the Windows installer **builds** with Inno Setup 7, installs an encrypted package for a developer who created their own recipient key, repairs, updates and rolls back correctly. Not verified: a **signed** installer (it is not code-signed), SmartScreen, other Windows versions and corporate application-control policies. Release scripts for npm and Maven prepare checksums, SBOM, licence inventory and signatures with a key you supply; **nothing is published**, and there is no GPG or Authenticode signing.

Output labelled *verified* below was captured from a real run on an isolated temporary installation root; ids, sizes and times belong to that run.

## 1. The package

A `.psopkg` is one file: a JSON header (name, version, platform, components, file list with SHA-256), a payload (zstd-compressed archive, optionally AES-256-GCM encrypted) and an **Ed25519 signature** over the header and payload digests. The signature is verified against keys **you** trust *before* anything is decrypted or decompressed.

```bash
pso dist keygen --kind signing   --out keys --name release     # keep release.private.pem secret
pso dist keygen --kind recipient --out keys --name customer    # only needed for encrypted packages
pso dist build  --out stage                                    # allowlist from dist.config.json; secrets are excluded and reported
pso dist pack   --stage stage --sign-key keys/release.private.pem --out pso.psopkg
pso dist verify pso.psopkg --trust keys/release.public.pem
```

What a package of the framework's own CLI looks like (Expected output; 6958 files, 11.2 MB, built from `dist.config.json` in the repository):

```text evidence="expected"
$ pso dist inspect pso-0.1.0.psopkg --trust release.public.pem
pso 0.1.0 (win32/x64) signed by 08f3c745354b3cc3
components: cli@0.1.0
not encrypted
6958 file(s)

$ pso dist verify pso-0.1.0.psopkg --trust release.public.pem
OK  pso 0.1.0 (win32/x64), 6958 file(s), signed by 08f3c745354b3cc3
every file was decompressed and its SHA-256 checked
```

- Nothing is signed or encrypted unless you pass a key. Private keys are never printed and never overwritten.
- `--encrypt --recipient <public.pem>` wraps a random content key for each recipient (X25519 + HKDF + AES-256-GCM). There is **no universal key**. `verify` of an encrypted package without the recipient key checks only the header and signature and says so.
- Extraction refuses absolute paths, `..`, drive letters, reserved names, case-duplicates and links, enforces size and ratio limits, and is all-or-nothing.
- Encryption protects content in transit and at rest. It does **not** prevent a legitimate recipient from reverse engineering what they receive.
- Keys: keep signing keys outside the repository (the release scripts refuse a key located inside it); distribute only public keys.

## 2. Installation lifecycle

Every command operates on an explicit root: `--root`, else `PSO_HOME`, else the installation the running `pso` was started from (its own launcher says which). PSO never guesses a directory and refuses file system roots, home and system directories and links.

```bash
pso setup     --package pso.psopkg --root C:\Tools\pso --trust release.public.pem
pso integrity check --full --root C:\Tools\pso          # read-only
pso repair    --dry-run --root C:\Tools\pso
pso update    check   --catalog catalog.json --root C:\Tools\pso
pso update    install --catalog catalog.json --root C:\Tools\pso
pso update    rollback --root C:\Tools\pso
pso uninstall --complete --yes --root C:\Tools\pso
```

| Command | Guarantee |
|---|---|
| `setup` | Package fully verified first; side by side under `versions/<v>`; a signed inventory is stored with the trusted public key |
| `integrity` | Never modifies anything. Quick = presence and size; `--full` = SHA-256. Extra files are reported, not deleted |
| `repair` | Restores files of the **installed version only** from an authenticated package; never upgrades; config, cache and logs are untouched; failure rolls back |
| `update` | Signed catalog with expiry and a rising `sequence` (replay protection); channels stable/beta/dev; size and SHA-256 checked; new version verified before an atomic switch; previous version kept; interrupted updates are cleaned up |
| `uninstall` | Removes only files listed in the inventory; links are unlinked, never followed. Standard keeps config/cache/logs; `--complete` removes everything PSO owns; `--purge` also deletes projects you name with `--project <dir> --confirm <same dir>` that carry a PSO marker file |

Exit codes: `0` success, `1` problems found or refusal, `2` blocked by a missing toolchain (installer).

### Install and verify (Expected output)

```text evidence="expected"
$ pso setup --package pso-0.1.0.psopkg --root <root> --trust release.public.pem
installed 0.1.0 (6958 file(s)) into <root>

$ pso setup ...  (again)
error: INSTALL_EXISTS: version 0.1.0 is already installed

$ pso integrity check --full --root <root>
OK  <root>  version 0.1.0  (full check)
  ok   installation state: install.json lists 1 version(s)
  ok   inventory signature: signed by a trusted key; 6958 file(s)
  ok   version: 0.1.0
  ok   file hashes (SHA-256): 6958 of 6958 file(s) intact
  ok   unexpected files: none
  ok   repair source: the authenticated package is cached
  ok   shim bin/pso.cmd: present in the version directory
```

What was installed: under `<root>` there are `versions/0.1.0/` (the files of the package: `bin/pso.cmd`, `node_modules/@pso/...`), `.pso-install/` (`install.json`, the signed `inventory-0.1.0.json`, `packages/0.1.0.psopkg` as the repair source, `trust/*.public.pem`) and the owned user-data directories `config`, `cache`, `logs`.

### Damage, detect, repair (Expected output)

A file was deleted and another corrupted:

```text evidence="expected"
$ pso integrity check --full --root <root>
PROBLEMS  <root>  version 0.1.0  (full check)
  ok   inventory signature: signed by a trusted key; 6958 file(s)
  FAIL file hashes (SHA-256): 2 of 6958 file(s) damaged
  FAIL shim bin/pso.cmd: missing
  damaged: bin/pso.cmd (missing)
  damaged: node_modules/marked/package.json (size-mismatch)
Run `pso repair` to restore damaged files from the authenticated package.
[exit 1]

$ pso repair --dry-run --root <root>
[dry-run] would restore 2 file(s) of 0.1.0 from the cached package:
  bin/pso.cmd
  node_modules/marked/package.json

$ pso repair --full --root <root>
restored 2 file(s) of 0.1.0 from the cached package:
  bin/pso.cmd
  node_modules/marked/package.json
```

> [!NOTE]
> Corrupting `marked/package.json`, a dependency of the installed CLI itself, left the installed `pso` unable to start, so the repair above was run from a **known-good copy** of the CLI (`node <good>/bin/pso.js repair ... --root <root>`). That is a real recovery path: the repair needs any working CLI and the cached package, not the damaged install.

A quick check only compares presence and size; only `--full` finds same-size corruption.

### Update and rollback (Expected output)

```text evidence="expected"
$ pso update check --catalog catalog.json --root <root>
update available: 0.1.0 -> 0.1.1 (stable)

$ pso update install --catalog catalog.json --root <root>
updated 0.1.0 -> 0.1.1. The previous version is kept: `pso update rollback` returns to it.

$ pso integrity check --root <root>
OK  <root>  version 0.1.1  (quick check)
  ok   installation state: install.json lists 2 version(s)
  ...

$ pso update rollback --root <root>
rolled back 0.1.1 -> 0.1.0
```

An update catalog is signed (Ed25519), expires, carries a rising `sequence` (an older catalog is refused as a replay) and lists packages by size and SHA-256. A forged, expired or replayed catalog, a package that does not match its catalog entry, and an unsigned or foreign offline package are all refused (covered by the framework's tests). Between versions nothing is overwritten: the new version is installed beside the old one, expected, and only then activated atomically.

### Uninstall (Expected output)

```text evidence="expected"
$ pso uninstall --root <root>
error: uninstall is destructive and needs --yes
hint: Review the mode first: standard keeps user data, --complete removes all PSO-owned data, --purge also deletes the projects you name

$ pso uninstall --complete --yes --root <root>
complete uninstall: removed 13925 file(s) and 298 director(ies)
```

A foreign file placed in the root is left alone (observed in an earlier installer run: `keep.txt` survived; that run is recorded in the progress record, not re-run here), and the root directory itself is removed only if nothing foreign remains.

## 3. The Windows installer

> [!NOTE]
> The current release, PSO Web V2 `0.2.0-rc.5`, publishes its installer as an **experimental, Authenticode-unsigned** asset ([Downloads](/downloads/index)): an unencrypted developer distribution that bundles its private Node.js, needs no signer fingerprint, and installs silently only with the explicit acknowledgement `/VERYSILENT /SUPPRESSMSGBOXES /ACCEPTUNSIGNEDALPHA=1 /DIR=<folder>` (its `INSTALL.md`). Its Windows installation flow is not validated end to end; the portable ZIP is recommended. The encrypted, recipient-pinned flow below (`/SIGNER=`, Node.js on PATH) is the one of the historical `0.1.0-alpha.1` installer, kept as the reference for private encrypted releases.

```bash
pso dist installer --platform windows --package pso.psopkg --bootstrap pso-bootstrap.mjs --trust keys/release.public.pem --name PSO-Web-<version>-win-x64 --out inst
```

With `--publisher "<certificate common name>" --sign-command "<command containing $f>"` the installer is Authenticode-signed while it is built: Inno Setup runs the command on the uninstaller during compilation and on the finished installer (`SignTool=`, `SignedUninstaller=yes`) and refuses a file that comes back unsigned. The release pipeline passes `scripts/psd/codesign.mjs sign` (SHA-256, RFC 3161 timestamp) and then enforces its release gate ([release integrity](/infrastructure/release-integrity-and-signing#windows-code-signing)). `--sign-command` is refused together with `--dev-distribution`.

The command writes `pso-setup.iss` and compiles it with Inno Setup 6 or 7 (`ISCC` environment variable or the default install locations). Without Inno Setup it reports `BLOCKED` and exits `2`. The output is the installer plus a manifest with its SHA-256.

The installer carries exactly three things, all extracted on demand to a temporary folder and none copied by Inno Setup itself:

| Carried | Purpose |
|---|---|
| the signed `.psopkg` (already compressed; for a private release also **encrypted**) | the product |
| **one** public signing key | to be compared with the signer the developer trusts, never a trust anchor by itself |
| `pso-bootstrap.mjs`, one small readable file | verify, decrypt, extract and activate; it contains none of the CLI, the deployment engine, Studio or any other part of PSO |

Earlier versions of the installer also copied the whole CLI, in plaintext, to a temporary folder to run `pso setup` from it. That made encrypting the package pointless, and it is gone: `--stage` is refused.

What the installer does, in order, **before Inno Setup installs anything**: it checks Node.js 24 or newer; it shows the signing key fingerprint; it runs the bootstrap, which refuses unless the signer is one the developer pinned (or passed as `/SIGNER=<64 hex>`), verifies the Ed25519 signature before decrypting, finds the developer's recipient identity (see [Recipient keys](#recipient-keys-for-a-private-release)), decrypts, checks every file against the signed header and extracts into a staging folder, then activates the version with renames. A refusal returns a message and a non-zero exit code and leaves nothing behind, not even an uninstall entry. Uninstalling from Windows Settings runs `pso uninstall --complete` with the active version's CLI and, if that CLI is itself damaged and cannot, with the previous version's CLI, which is kept side by side (the uninstall works from the signed inventories of every version). The installer is **per user** on purpose: the developer's key is protected for one Windows account, and an installer elevated as a *different* account could not open it.

```text evidence="expected"
$ PSO-Web-0.1.0-alpha.1-win-x64.exe /VERYSILENT /SUPPRESSMSGBOXES /DIR=C:\Tools\pso /SIGNER=<fingerprint> /LOG=setup.log
(exit 0)  install.json, inventory-0.1.0-alpha.1.json, packages/, trust/ under .pso-install; versions/0.1.0-alpha.1/

$ ... the signer is not the one you pinned
(non-zero exit; setup.log: SIGNER_NOT_TRUSTED ... Nothing was installed.)
```

Without `--sign-command` the result is **not Authenticode-signed**: signing needs a publicly trusted code-signing certificate, which no PSO release has yet. Integrity and authenticity come from the SHA-256 and the Ed25519 signature published with the release, checked against a fingerprint you received through a different channel.

### What was verified, and what was not

| Step | Result |
|---|---|
| compile with Inno Setup 7 | verified |
| silent install of an encrypted package, as a recipient with a DPAPI-protected key | verified (exit 0, the layout above, `integrity check --full` OK) |
| refusal without an independent trust anchor, with a foreign signer, with a modified package, as a developer who is not a recipient | verified by tests of the bootstrap and by a real run of the compiled installer (non-zero exit, nothing left behind) |
| interrupted installation | verified: a stale staging folder with decrypted files is removed by the next operation |
| Inno uninstaller `unins000.exe` | ran and removed its registry entry in the validation of 2026-11-16; an earlier run on another machine state was blocked by Windows application control because the installer is unsigned |
| a signed installer, SmartScreen behaviour, other Windows versions, a corporate application-control policy | not tested |

> [!WARNING]
> Do not distribute the unsigned installer expecting a clean experience: the operating system may warn about an unknown publisher or block the installer or its uninstaller. Report such a block; do not work around it.

## Recipient keys for a private release

A private release is encrypted for the developers you authorize, one wrapped content key each. **A developer creates their own key pair; the maintainer never sees a private key.**

```bash
# the utility is one file: node pso-recipient.mjs <command>; shown here as pso-recipient
pso-recipient init --label "Ana Souza"            # creates the key pair on this machine, protected by Windows DPAPI (this account only)
pso-recipient show                                # fingerprint, protection, pinned signers
pso-recipient pin-signer --fingerprint <64 hex>   # the maintainer's signing key, received through a different channel
pso-recipient backup --out ana.backup.json        # passphrase-protected backup (recovery)
pso-recipient doctor                              # which account you run as, whether DPAPI works, whether the session is elevated
```

1. The developer obtains the `pso-recipient.mjs` utility and checks its SHA-256 against the value the maintainer published through a second channel. It is a single readable file with no network code.
2. `pso-recipient init` writes `<label>.enrollment.json` (public key and fingerprint only). The private key is stored DPAPI-protected (`CurrentUser`) in `%LOCALAPPDATA%\PSO\recipient`, or, where DPAPI is unavailable (PowerShell in Constrained Language Mode, non-Windows), under a passphrase (scrypt + AES-256-GCM).
3. The developer sends the enrollment file, and reads the fingerprint to the maintainer by another channel. The maintainer compares them and only then adds the public key to the recipients of the next release.
4. The maintainer encrypts the release for all authorized recipients with the unchanged `pso dist pack --encrypt --recipient a.pem,b.pem`. One installer serves them all.
5. The developer pins the maintainer's signer fingerprint once. From then on `pso repair` and `pso update` open the same identity, only when an encrypted package actually has to be read.

| Situation | Consequence |
|---|---|
| lost key, no backup | releases encrypted for it cannot be decrypted by anyone; enroll a new key and ask for a release that includes it |
| Windows account changed or profile rebuilt | the DPAPI blob cannot be opened; restore from the backup (`pso-recipient restore`) or enroll a new key |
| new machine | restore from the backup; DPAPI re-protects the key for the new account |
| installer started elevated as another account | the key is not readable there: `DPAPI_UNPROTECT_FAILED`; run it as the account that created the key |
| a recipient is removed | **future** releases are not encrypted for them. Releases they already hold stay readable: removal cannot revoke earlier copies |

Encryption controls who can *install* a release. It does not prevent an authorized developer from inspecting what is installed on their own machine; see [Protection and its limits](#protection-and-its-limits).

## Protection and its limits

The installed framework is a distribution assembled from an explicit, classified allowlist, not a copy of the development repository: no sources, no tests, no source maps, no internal reports. Its JavaScript is bundled and minified with internal identifiers mangled; the engines that hold the most algorithms receive additional string and control-flow transforms; the public SDK is left readable on purpose because developers build on it. The agent that runs on Linux servers is protected the same way.

This raises the effort of reading and re-creating the implementation. It does **not** make it impossible: the code runs on the recipient's machine, so a determined developer with debugging tools or AI-assisted deobfuscation can still recover its behaviour. No anti-debugging, no antivirus evasion and no destructive anti-tamper is used. Installed files are checked against a signed inventory (`pso integrity check`) and repaired from the authenticated, encrypted package; that detects accidental damage and casual edits, and it is not a security boundary against the device owner.

## 4. Release evidence for npm and Maven

```bash
node scripts/release.mjs npm   --out release-out/npm   [--sign-key <ed25519 private pem>]
node scripts/release-maven.mjs --out release-out/maven [--sign-key <ed25519 private pem>]
node scripts/verify-release.mjs release-out/npm --trust <public pem>
```

Both scripts work on temporary copies, write artifacts to `--out`, and **publish nothing**. Verified stage report of the npm script (one run):

```text evidence="expected"
PASSED   pack - 5 tarballs: @pso/core@0.1.0, @pso/security@0.1.0, @pso/dispatch@0.1.0, @pso/http@0.1.0, @pso/cli@0.1.0
PASSED   reproducible tarballs - two independent packs have identical integrity
PASSED   content policy - no tests, maps, env files or key material in any tarball
PASSED   secret scan - 6 secret patterns, no findings
PASSED   SBOM (CycloneDX) - 39 components, production tree from package-lock.json
PASSED   licence inventory - licences: MIT, Apache-2.0, BSD-3-Clause, ISC; own packages Apache-2.0
NOT RUN  vulnerability audit - --skip-audit
PASSED   checksums + provenance - SHA256SUMS, manifest.json, provenance.json (self-asserted, not an attested SLSA build)
PASSED   signing - Ed25519 signature of SHA256SUMS and manifest.json (verify with signing-key.public.pem)
PASSED   clean install - outside the monorepo from tarballs: cli --help exit 0; imports imports-ok
```

`verify-release.mjs` checks the signature of `SHA256SUMS`, every checksum, the manifest signature and the DSSE provenance envelope against a public key **you** trust, and rejects (expected by tests): an untrusted key, a modified tarball, a modified checksum file, a swapped provenance subject, an unsigned release, and a signing key located inside the repository.

What this evidence does and does not give you:

| Item | Status |
|---|---|
| SHA-256 sums, SBOM, licence inventory, secret scan | produced and checked |
| Ed25519 signature over the checksums | only with a key you supply; unsigned otherwise (reported as `NOT RUN`) |
| provenance | **self-asserted** by the build machine; not an attested SLSA build (that needs a hosted builder that signs it) |
| GPG signatures for Maven Central, Authenticode for Windows | not done: they need keys and certificates only you can provide |
| vulnerability scanning | `npm audit` for the production tree; Maven dependencies are not scanned |
| licence | PSO Web Framework is licensed under Apache-2.0: every package declares it and ships `LICENSE` and `NOTICE`; third-party licenses are inventoried per release (`docs/commercial/licensing-status.md` in the repository) |


## Variations

| Situation | Use |
|---|---|
| distribute to a customer you know | `--encrypt --recipient customer.public.pem`, plus the signature |
| air-gapped machine | `pso update install --package <file>` (offline packages are verified the same way) |
| several machines on one version | publish a signed catalog and run `update check` on a schedule |
| a corrupted install | `pso integrity check --full`, then `pso repair` from a good copy |

## Common mistakes

- Trusting a public key you did not receive over a trusted channel.
- Putting the signing key in the repository (the scripts refuse it).
- Expecting `repair` to upgrade (it restores the installed version only).
- Running a destructive uninstall test on your own workstation: use a temporary `--root`.

## Next steps

- [CI/CD](/devops/ci-cd)
- [Build and deploy](/devops/build-and-deploy)
- [Installation](/getting-started/installation)
