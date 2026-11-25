# Installing PSO Web {{LABEL}}

**You need:** Windows 10/11 x64. PSO carries its own private Node.js runtime.

## Verify

1. Download `PSO-Web-{{LABEL}}-win-x64.exe` from the official release page.
2. `Get-AuthenticodeSignature .\PSO-Web-{{LABEL}}-win-x64.exe` must show status `Valid` and signer `CN={{PUBLISHER}}`. If it does not, do not run it.
3. Optionally compare its SHA-256 with `SHA256SUMS` (`Get-FileHash .\PSO-Web-{{LABEL}}-win-x64.exe`).

## Install

Double-click the installer. Windows shows **{{PUBLISHER}}** as the verified publisher. Choose the folder (default: your user profile's
`Programs\PSO`; no administrator rights are needed), keep *Add PSO to my PATH*, and finish. In a new terminal: `pso --version` and `pso doctor`.

Silent installation: `PSO-Web-{{LABEL}}-win-x64.exe /VERYSILENT /SUPPRESSMSGBOXES /DIR=C:\Tools\pso /LOG=setup.log`. The installer verifies
its own publisher before it installs anything and refuses when the file is not the signed original.

## Maintain

* `pso integrity check --full`, `pso repair --full`: verify and restore every file against the signed package.
* `pso update install --package <newer .psopkg>`: update in place (only packages signed by the same key); `pso update rollback`: return to the previous version.
* Uninstall from *Settings → Apps* (the uninstaller is signed by {{PUBLISHER}}). Your projects are never inside the installation folder.

## Security limits

The Authenticode signature identifies the publisher and protects the installer and the uninstaller against modification; the Ed25519
package signature protects every installed file. Never disable Smart App Control, SmartScreen or Defender to install PSO: if a policy
blocks the file, ask your administrator.
