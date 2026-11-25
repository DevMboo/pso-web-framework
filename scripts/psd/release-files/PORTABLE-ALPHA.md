# PSO Web {{LABEL}} — Portable (Unsigned Developer Alpha)

> **Unsigned, experimental.** This ZIP is not code-signed and Windows has not verified who published it. The project is **PSO Web Framework** (maintainer: DevMboo, https://github.com/DevMboo; free and open-source software under the Apache License 2.0); nothing here lets Windows or you verify that independently. Integrity is checked (package signature, per-file hashes), publisher identity is **not** authenticated. See [Security limits](#security-limits).

## Use

You need Windows 10/11 x64. No Node.js, Java or installer is needed.

1. Download `{{ZIP}}` from the official release page of `DevMboo/pso-web-framework` and compare its SHA-256 with `SHA256SUMS` on that page (`Get-FileHash .\{{ZIP}}`).
2. Extract it to a folder you can write to, for example `C:\Tools\pso` or `%LOCALAPPDATA%\PSO`. Do not use `Program Files`. The folder can be moved or renamed afterwards.
3. Run it, with the full path or from inside the folder:

   ```
   .\pso.cmd --version
   .\pso.cmd doctor
   ```

4. Optional: to type just `pso`, add the extracted folder's `bin` directory to **your user** PATH (Settings → System → About → Advanced system settings → Environment Variables → User variable `Path` → New). Nothing else on your machine is changed by this ZIP: it installs nothing, writes no registry keys and does not touch any Node.js you have.

## Maintenance

* `pso.cmd integrity check --full` verifies every file against the signed inventory; `pso.cmd repair --full` restores damaged files from the authenticated package kept in `.pso-install\`.
* `pso.cmd update install --package <newer .psopkg>` updates in place; only packages signed by the key this ZIP was built with are accepted.
* To remove PSO, delete the folder (and the PATH entry if you added one). Your own projects are never inside it.

## Windows protections

Smart App Control, SmartScreen, Defender and enterprise application-control policies are neither bypassed nor weakened. The ZIP contains only `node.exe` (Authenticode-signed by the OpenJS Foundation) and scripts; if your organization still blocks it, ask your administrator to approve it by SHA-256 or wait for a signed release.

## Security limits

* **No independent publisher authentication.** The package-signing key (fingerprint `{{FINGERPRINT}}`) travels inside the same ZIP. It proves the files were not corrupted and belong to one signed package, not who produced the ZIP you downloaded. The checksum from the same release page has the same limit if that page were compromised.
* The contents are not encrypted.
* After you start using it, PSO trusts exactly this key for updates and refuses packages signed by another.
* Future signed releases will use a stricter, Authenticode-verified path.
