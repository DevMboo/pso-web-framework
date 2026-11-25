# PSO Web {{LABEL}} — Unsigned Developer Alpha

**Unsigned alpha notice.** Nothing in this release is Authenticode-signed and Windows has not verified the publisher. Project: PSO Web Framework (maintainer: DevMboo, https://github.com/DevMboo), free and open-source software under the Apache License 2.0. The signing key shipped with the files provides integrity, not publisher authentication (fingerprint `{{FINGERPRINT}}`, informational only).

Corrective release for `0.1.0-alpha.1`, whose installer needed a manually supplied signer fingerprint, Node.js on PATH and an enrolled recipient key, and whose `pso` launcher could not run.

## Assets

| Asset | Status |
|---|---|
| `{{ZIP}}` (SHA-256 `{{ZIP_SHA256}}`) | **Recommended for this alpha.** Portable, no installation, bundled private Node.js, working `pso.cmd`. Validated from the exact ZIP in an isolated folder with no Node.js on PATH. See `PORTABLE.md`. |
| `PSO-Web-{{LABEL}}-win-x64.exe` | **Experimental, not validated end to end.** Inno installer with the same content. Its real Windows installation flow (wizard, PATH entry, uninstaller) has **not** been executed, because the validation machine's Smart App Control refuses to start any unsigned installer. Windows Smart App Control may block it on your machine too. Not a supported installation method yet. |
| `SHA256SUMS`, `SHA256SUMS.sig` | Checksums of all assets, signed with the key above (integrity only). |

## What changed since alpha.1

* Unencrypted alpha package: no recipient enrollment, fingerprint, or `pin-signer`.
* Private bundled Node.js runtime (Authenticode-signed by the OpenJS Foundation); no global Node change.
* Working launcher (`pso.cmd`): the alpha.1 launcher was corrupted and its `bin` folder never created.
* Package validation unchanged: signature, per-file hashes, safe extraction, interrupted-install recovery, repair, rollback. A machine or installation that already trusts a signer is never downgraded to this unauthenticated mode.

## Known limits

No Authenticode signature; Smart App Control, SmartScreen or enterprise policy may block the installer; no independent publisher authentication; package not encrypted; Windows x64 only; no independent security review.
