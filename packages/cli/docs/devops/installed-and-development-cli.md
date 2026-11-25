---
title: Installed CLI and framework development CLI
description: Which installation answers to the pso command in a terminal, how an npm-linked development checkout shadows an installed distribution, how to find and resolve PATH conflicts on Windows (PowerShell, CMD, Git Bash), and how to keep pso (installed) and pso-dev (framework checkout) apart.
order: 10
status: implemented
keywords: [path, npm link, shadowing, pso-dev, installed, portable, development, which, where, get-command, windows]
related: [devops/distribution-and-installation, infrastructure/release-integrity-and-signing, getting-started/installation]
---
> [!STATUS]
> **Implemented and verified** on Windows 11 with PowerShell, CMD and Git Bash: an npm-global link to a framework checkout was found shadowing the installed distribution in all three shells and was resolved without deleting the checkout or any other npm package.

Two things can answer to `pso` on one machine:

| | Installed distribution | Framework development checkout |
|---|---|---|
| What it is | a portable folder or an installer installation: a private Node.js runtime, a signed package, `bin\pso.cmd` | `packages/cli/bin/pso.js` of a clone of the framework repository |
| Used for | building applications with a released PSO | changing PSO itself |
| Integrity | `pso integrity check --full`, `pso repair --full` | none: it is source |
| Command | `pso` | `pso-dev` (recommended) or `node <checkout>\packages\cli\bin\pso.js` |

An application should be built with the installed `pso`. Use the checkout only to work on the framework.

## Find out which installation answers

```powershell
Get-Command pso -All | Format-Table CommandType, Source     # PowerShell: the first row wins
where pso                                                   # CMD
type -a pso                                                 # Git Bash
pso --version
```

The installed distribution resolves to `<installation>\bin\pso.cmd` (or `pso-launch.mjs` behind it). A path under `%APPDATA%\npm` (`pso`, `pso.cmd`, `pso.ps1`) is an **npm-global package or link**, often `npm link` run in `packages/cli` of a checkout:

```powershell
npm ls -g --depth=0        # "@pso/cli@0.2.0 -> .\D:\...\pso-web-framework\packages\cli" is a development link
```

Because `%APPDATA%\npm` usually comes before other user PATH entries, that link shadows the installed distribution in every shell, and `pso --version` alone cannot tell them apart (both may say 0.2.0).

## Resolve the conflict

1. Back up first: `reg export HKCU\Environment env-backup.reg` and `npm ls -g --depth=0 > npm-global.txt`.
2. Remove only the global link. The checkout and every other global package stay:

   ```powershell
   npm rm -g @pso/cli
   ```

3. Give the checkout its own name. The framework repository has `tools\dev-bin` (`pso-dev.cmd` for PowerShell and CMD, `pso-dev` for Git Bash), which runs the checkout's `packages/cli/bin/pso.js` with your Node.js. Add that folder to your **user** PATH, after the installed distribution's `bin`.
4. Put the installed distribution's `bin` on your user PATH (the installer does it when its PATH task is selected; for the portable ZIP add `<folder>\bin` yourself).
5. Open a **new** terminal (running terminals keep the old PATH) and check again with the commands above.

A PATH entry that points to a folder that no longer exists (for example a temporary test installation) is harmless but confusing; remove only that entry, after backing up the value.

## What goes wrong

- `pso` still runs the checkout: the terminal was opened before the change, or another `pso` (a second npm prefix, `nvm`, a copied shim) comes first; `Get-Command pso -All` shows it.
- `pso-dev` fails with `Cannot find module`: the checkout is not built (`npm run build` in it).
- `pso integrity check` says `no installation root`: it ran from the development checkout, which is not an installation; an installed `pso` uses its own installation automatically.
