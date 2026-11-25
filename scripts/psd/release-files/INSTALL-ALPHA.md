# Installing PSO Web {{LABEL}} (Unsigned Developer Alpha)

> **Unsigned alpha notice.** This build is experimental and **not Authenticode-signed**. Windows has not verified who published it, and may show an "unknown publisher" warning. The project is **PSO Web Framework** (maintainer: DevMboo, https://github.com/DevMboo; free and open-source software under the Apache License 2.0), but nothing in this installer lets Windows or you verify that independently. Read [Security limits](#security-limits) before you install.

**You need:** Windows 10/11 x64. Nothing else: no Node.js, Java, Inno Setup or build tools for the PSO CLI itself (PSO carries its own private Node.js runtime).

## Install

1. Download `PSO-Web-{{LABEL}}-win-x64.exe` **only from the official release page** of `DevMboo/pso-web-releases`.
2. Compare its SHA-256 with `SHA256SUMS` on that page: `Get-FileHash .\PSO-Web-{{LABEL}}-win-x64.exe` (PowerShell). If they differ, do not run it.
3. Double-click the installer. If Windows SmartScreen warns about an unknown publisher, that is expected for this unsigned alpha: choose *More info → Run anyway* only if you downloaded the file from the official page and the checksum matched. PSO never changes or suppresses Windows warnings.
4. Read the **Unsigned developer alpha** page and click *Next* only if you accept it.
5. Choose the folder if you like (default: your user profile's `Programs\PSO`; no administrator rights are needed or used), keep *Add PSO to my PATH* ticked, and finish.
6. Open a **new** terminal and run:

   ```
   pso --version
   pso doctor
   ```

No fingerprint, no key and no command is needed to install.

**Silent / automated install** (explicit acknowledgement is mandatory because there is no notice page):

```
PSO-Web-{{LABEL}}-win-x64.exe /VERYSILENT /SUPPRESSMSGBOXES /ACCEPTUNSIGNEDALPHA=1 /DIR=C:\Tools\pso /LOG=setup.log
```

## What the installer does and does not touch

* Installs into one folder (`bin\`, `runtime\`, `versions\`, `.pso-install\`). The Node.js runtime in `runtime\` is **private to PSO**: it is not added to PATH, not registered and does not affect any Node.js you have.
* Adds only `<install dir>\bin` to **your user** PATH (if ticked). Uninstall removes exactly that entry.
* On failure nothing is left behind (a root created by the failed run is removed). Your projects and data are never inside the installation and are never removed.

## Update, repair, uninstall

* Install a newer installer over the same folder, or run `pso update install --package <file>`; the installation trusts only the key it was installed with, and an installer signed by another key is **refused** (no silent trust change).
* `pso integrity check --full` and `pso repair --full` verify and restore installed files from the signed inventory.
* Uninstall from *Windows Settings → Apps*, or `pso uninstall --complete --yes`.

## Security limits

* **No independent publisher authentication.** The installer carries its own package-signing key (fingerprint `{{FINGERPRINT}}`). That key proves the package was not corrupted and was signed by the same key throughout, **not** who produced the first file you ran: whoever could replace the installer could replace the key. The SHA-256 checksum from the same release page has the same limit if the page itself were compromised.
* After the first install, PSO trusts exactly that key for later packages and updates. An installer signed by a different key is refused on a machine that already trusts one, and a trusted installation is never downgraded to this unsigned distribution.
* The package is **not encrypted**; the installation is readable by anyone with access to the file.
* Windows Defender, SmartScreen and enterprise application-control policies are not bypassed. If your organization blocks unsigned executables, this alpha will be blocked; ask your administrator to allow the installer by its SHA-256 hash, or wait for a signed release.
* Bundled Node.js `{{NODE_SHA256}}` is the official Windows build, Authenticode-signed by the OpenJS Foundation.
* Future signed releases use a stricter path (Authenticode-verified publisher); an installation made from this alpha can be replaced by one of them with a clean uninstall and install.
