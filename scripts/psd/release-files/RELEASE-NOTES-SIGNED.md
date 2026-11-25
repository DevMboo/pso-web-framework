# PSO Web {{LABEL}}

**One ecosystem. Independent teams. Unified architecture.**

## Signing

* The installer `PSO-Web-{{LABEL}}-win-x64.exe` and its uninstaller are **Authenticode-signed by {{PUBLISHER}}** with SHA-256 and an RFC 3161
  timestamp. Windows shows **{{PUBLISHER}}** as the verified publisher. Check it with `Get-AuthenticodeSignature .\PSO-Web-{{LABEL}}-win-x64.exe`:
  the status must be `Valid` and the signer `CN={{PUBLISHER}}`.
* The bundled Node.js runtime keeps its own signature (OpenJS Foundation); PSO never re-signs third-party files.
* The package inside is signed with Ed25519 (fingerprint `{{FINGERPRINT}}`); installation, repair and updates verify every file against it.
* `SHA256SUMS` is computed after signing and signed with the same Ed25519 key.

## Known limits

* Windows x64 only. Smart App Control and organizational policy decide whether a signed file is allowed; a newly issued certificate can
  need time to build reputation. PSO never asks you to switch Windows protection off.
* Scripts (`pso.cmd`, the Maven wrapper of generated projects) cannot carry Authenticode signatures; they are covered by the package's
  per-file integrity check (`pso integrity check --full`).
