# PSO Web {{LABEL}} - Private Developer Preview

**One ecosystem. Independent teams. Unified architecture.**

First protected distribution of PSO Web for a small group of invited developers. It is the complete framework: CLI, orchestrator and Spring Boot service templates, FEI and MEI frontends, Studio, the cloud deployment engine and agent, Dispatch and Channels, security, documentation and the Java starters.

## What changed in how it is delivered

* The installer is **encrypted for individual developers**. Each developer creates their own key; the maintainer never receives a private key.
* The installer verifies a signature against a signer **you confirmed with a fingerprint obtained through another channel** (typed into the installer, passed as `/SIGNER=`, or pinned earlier) before it decrypts anything, and refuses otherwise.
* The installed framework contains no sources, tests, source maps or internal reports; the framework's JavaScript is bundled and minified (its source code is licensed under the Apache License 2.0); Java artifacts are compiled only.
* Installation, update, repair, integrity check, rollback and uninstall are unchanged for you; repair and update use the authenticated encrypted package.

## Known limits of this preview

* The installer is **not Authenticode-signed** (no code-signing certificate yet): Windows may warn about an unknown publisher, and a corporate application-control policy may block it.
* Node.js 24 or newer is required on PATH. Windows 10/11 x64 only.
* Protection raises effort; it is not immunity. Local software can always be examined by the person who runs it.
* Distribution is private. Do not redistribute the installer.

See `INSTALL.md` for the steps and `THIRD-PARTY-NOTICES.txt` and `dependency-inventory.json` for what is included.
