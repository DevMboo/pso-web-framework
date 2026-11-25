# SignPath Foundation readiness (maintainer document)

Status on 2026-11-25 (re-evaluated after the first public release): the formal conditions that the project controls are **met** (open-source license, public repository, public release, policies, metadata); the application is **ready but not submitted** (section 6), and the open concerns are reputation, the Inno Setup runtime and the network diagnostic (section 6b). Nothing is signed through SignPath. The terms reviewed are
https://signpath.org/terms (marked "Draft" by SignPath on that date); re-read them before applying.

## 1. Eligibility audit

| SignPath condition | PSO Web today | Result |
|---|---|---|
| OSI-approved license, no commercial dual licensing, for **all** components | **Apache-2.0** for every PSO component: `LICENSE` (official text), `NOTICE`, every `package.json`, the Maven parent POM and BOM, the installed distribution and the release SBOMs; no dual licensing | **met** (2026-11-25) |
| no proprietary component (especially code of the maintainer) | all PSO code is Apache-2.0; bundled third-party npm packages are MIT/Apache-2.0/BSD-3-Clause/ISC; the Node.js runtime is MIT. The PSD build still bundles and minifies the JavaScript (class A/B protection) and can encrypt packages per recipient: for a signed OSS release build it unencrypted and without `--obfuscate`, so the shipped code corresponds to the public source | met for the code; build mode to follow for OSS releases |
| public source repository; verifiable build from source | https://github.com/DevMboo/pso-web-framework: public, Apache-2.0 detected by GitHub; `0.2.0-rc.4` was built from a fresh clone of the tagged commit `a56a6ac` (`npm ci`, `npm run build`, Maven release build); secret scanning with push protection, private vulnerability reporting, Dependabot, read-only Actions token | **met**: public since 2026-11-25 (https://github.com/DevMboo/pso-web-framework), main protected against deletion and force pushes |
| released in the form to be signed | `0.2.0-rc.4` installer and portable ZIP are published as a **public** prerelease of the source repository: https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.4 (built from commit `a56a6ac`, labelled Authenticode-unsigned) | **met** (2026-11-25) |
| functionality described on the download page | the Downloads page and documentation describe it | met |
| actively maintained | yes | met |
| reputation (required for executable programs) | public since 2026-11-25, one public release, no stars, forks or external users yet; the maintainer account is from 2020 | **risk**: SignPath may decline; no threshold is published |
| sign own binaries only; upstream binaries never signed | only the installer and the Inno uninstaller/self-copy are submitted; `node.exe` keeps the OpenJS signature (verified, never re-signed) | met (implemented) |
| upstream components inside signed packages | the installer embeds the Inno Setup runtime (its setup program, which is also the uninstaller and the temporary self-copy) and the Node.js runtime (MIT). Inno Setup License (read from `license.txt` of Inno Setup 7.1.1): use and redistribution for any purpose, including commercial, if copyright notices and web site addresses in the binaries are kept and the origin is not misrepresented; acknowledgement appreciated (given in `NOTICE`). It is permissive but **not an OSI-listed license**, and the uninstaller/self-copy SignPath would sign is Inno's compiled code with PSO's version resource | **to confirm with SignPath**: whether signing the Inno setup program is acceptable (it is not built from this project's source; many OSS projects ship Inno installers) |
| no hacking tools ("active security diagnosis scanners", e.g. detecting unprotected network ports) | see section 1a: `pso environment:network` reads the listening sockets of the user's own enrolled server and compares them with that environment's declared exposure policy; with `--verify` it also opens one TCP connection from the user's machine to each non-loopback port that server reported. It does not scan address ranges or ports a server did not report, does not test credentials and exploits nothing. `pso security:check` / `security:audit` read the project's own configuration; the deployment agent's optional OSV-Scanner run checks the user's Java dependencies | **disclose**: the `--verify` probe is the closest match to SignPath's example; kept unchanged as a legitimate operational diagnostic of the operator's own infrastructure |
| privacy: data transferred to systems not specified by the user must be described, shown at installation and be optional | no telemetry; every connection is user-initiated ([privacy policy](../../packages/cli/docs/downloads/privacy-policy.md)); OSV-Scanner (a third-party tool the user installs) sends dependency coordinates to osv.dev, disclosed | met; if SignPath considers osv.dev "not specified by the user", the installer must also show the policy |
| announce system changes; provide uninstallation | PATH change is an explicit installer option; the hosts-file block is shown by `pso infra:plan` and needs administrator rights; signed uninstaller restores PATH and removes everything it installed | met |
| MFA for SignPath and GitHub for all team members | GitHub account `DevMboo`: the API did not disclose the two-factor status to this session's token, so it is **not verified** | **owner action**: confirm MFA before applying |
| roles: authors, reviewers, approvers | one person holds all roles (`DevMboo`), documented on the code signing policy page | met formally; SignPath may ask for more than one person |
| code signing policy on the home page and download page, with the attribution line and privacy policy | page `downloads/code-signing-policy` linked from the footer of every page (homepage included) and from Downloads; privacy policy page; the attribution line is **not** shown before acceptance | prepared |
| metadata: product name and version attributes set and enforced | installer and uninstaller: ProductName `PSO Web Framework`, ProductVersion = release label (numeric `major.minor.patch.0`), company and publisher = the maintainer `DevMboo` (`--app-publisher`), copyright `Copyright 2026 DevMboo. Licensed under the Apache License 2.0`; the Authenticode signer (`--publisher`, `SignPath Foundation`) is separate; enforced in `.signpath/artifact-configurations/*.xml` (product name; validate the version restriction in SignPath's editor) | prepared |
| every release manually approved; build not worked around | two signing requests per release, each approved in SignPath; the GitHub environment `release-signing` requires an approver before the job runs | prepared |

### 1a. `pso environment:network`, exactly

| Step | Where | What it does |
|---|---|---|
| 1 | the user's machine | `pso environment:network <application> [--verify]`: asks the PSO agent of an environment the user enrolled (`pso connection:add`, `pso agent:enroll`, role `viewer` or higher) for `network.exposure` |
| 2 | the user's server (agent) | reads `/proc/net/tcp` and `/proc/net/tcp6` (sockets in LISTEN state) and the owning processes, the nginx files PSO manages and the ports of PSO's own services; classifies each listener (loopback, private, all interfaces, public address) against the environment's policy (`intentionallyPublicPorts`, `infrastructureNetwork`) and names well-known infrastructure (PostgreSQL, Redis, RabbitMQ, Kafka, ...) bound to all interfaces. Read only; changes nothing |
| 3 | the user's machine, only with `--verify` | for each non-loopback listener the server reported, one TCP connection to the server's own host on that port (4 s timeout), recorded as open, refused or no-answer. No other host, port or range is contacted; no data is sent |
| 4 | the user's machine | prints the listeners, findings and remediation; exit code 1 when a listener is potentially unsafe |

## 2. Responsibilities

| Role | Responsibility |
|---|---|
| **Maintainer / committer** | owns the source repository, build scripts and workflow; keeps dependencies and the third-party inventory current; tags releases; keeps the code signing policy and privacy policy accurate; responds to SignPath investigations |
| **Reviewer** | reviews every change from non-committers before merge, with particular care for build scripts, `.github/workflows/`, `.signpath/` and `scripts/psd/` (they decide what is signed) |
| **Signing approver** | before approving a SignPath request: the request comes from the release workflow of the tagged commit; the tag is a reviewed release; the artifact is the expected one (uninstaller, then installer, product `PSO Web`, version = tag); the release notes are accurate. Rejects anything else |
| All | MFA on GitHub and SignPath; never share API tokens; report suspected misuse |

## 3. Information for the application (draft)

| Field | Value |
|---|---|
| Project name | PSO Web Framework (short name PSO Web; CLI command `pso`) |
| Description | a framework and CLI for building structured web applications: a TypeScript orchestrator, Spring Boot microservices, a local infrastructure engine, Studio and a deployment agent; Windows x64 distribution as installer and portable ZIP |
| Homepage / documentation | https://devmboo.github.io/pso-web-docs/ |
| Download page | https://devmboo.github.io/pso-web-docs/downloads/index.html (points at the public release https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.4) |
| Code signing policy | https://devmboo.github.io/pso-web-docs/downloads/code-signing-policy.html |
| Privacy policy | https://devmboo.github.io/pso-web-docs/downloads/privacy-policy.html |
| Source repository | https://github.com/DevMboo/pso-web-framework (public) |
| License | Apache-2.0, all components |
| Build system | GitHub Actions, GitHub-hosted Windows runners (`.github/workflows/signpath-release.yml`) |
| Artifacts per release | 2 signing requests: `inno-uninstaller` (uninst-*.e32) and `installer` (PSO-Web-<version>-win-x64.exe) |
| Team | DevMboo (maintainer: committer, reviewer, approver) |
| Disclosures | `pso environment:network --verify` (section 1a); the Inno Setup runtime inside the installer; OSV-Scanner integration of the deployment agent (optional, user-installed tool, sends dependency coordinates to osv.dev) |

### 3a. Disclosure text (paste into the application)

> **Network diagnostics.** PSO Web Framework includes `pso environment:network <application> [--verify]`, an operational diagnostic
> for servers the user has enrolled with the PSO deployment agent. The agent, running on the user's own server, reads that server's
> listening sockets (`/proc/net/tcp`, `/proc/net/tcp6`) and their owning processes, and compares each listener with the exposure
> policy the user declared for that environment (which ports are intentionally public; whether databases and brokers may listen on
> all interfaces). It reports findings and remediation and changes nothing. With `--verify`, the user's machine additionally opens
> one TCP connection, with a 4-second timeout and no data sent, to each non-loopback port that the server itself reported, on that
> same server only. It does not scan address ranges or other hosts, does not probe ports the server did not report, does not test
> credentials and does not exploit anything. It requires an enrolled connection with at least the viewer role.
>
> **Dependency scan.** The deployment agent can run OSV-Scanner, when the user has installed it, on the Java dependencies of the
> application being deployed; OSV-Scanner sends the dependency names and versions to the OSV database (osv.dev).
>
> **Installer runtime.** The Windows installer is built with Inno Setup. Its setup program, which is also the uninstaller and the
> temporary copy Setup runs, is Inno Setup's compiled code (Inno Setup License, permissive, not OSI-listed) with this project's
> version information; it is one of the two files submitted for signing.

## 4. Integration readiness

| Part | State |
|---|---|
| local SignTool signing, release gate, unsigned development mode | implemented and tested (`codesign.mjs`, `build-release.mjs`) |
| remote signing mode (`--remote-signing`, exit 4 / 5, `signpath-finalize.mjs`) | implemented; tested without a certificate (Inno refuses an unsigned uninstaller; signed file must equal the submitted build) |
| Inno Setup uninstaller and temporary self-copy (`--signed-uninstaller-dir`) | implemented; tested with Inno Setup 7.1.1 |
| version metadata | implemented and verified on real files |
| GitHub Actions workflow, SignPath artifact configurations | prepared, never run. Locked twice: it triggers only on final version tags (`v1.2.3`, never `-rc`), and its job runs only when the repository variable `PSO_SIGNPATH_ENABLED` is `true`; validated by actionlint 1.7.7. Confirm the SignPath action version and pin it and the other actions by commit SHA before the first run |
| Smart App Control validation | `validate/signed-sac.mjs`, for an isolated Windows 11 VM once a signed build exists |

Security note: a SignPath Foundation certificate is shared by many projects (the publisher Windows shows is "SignPath Foundation"). The
installer's Authenticode trust anchor therefore establishes "signed through SignPath", not "signed by PSO"; the PSO package signature
(Ed25519 key embedded in that signed installer) then authenticates the payload.

## 5. Manual steps for the owner (in order)

1. ~~License~~: done (Apache-2.0, 2026-11-25). ~~Product name and publisher~~: done (PSO Web Framework, maintainer DevMboo).
2. ~~`pso environment:network`~~: kept as a legitimate diagnostic and documented (section 1a); disclose it in the application.
3. ~~Public GitHub repository~~: done (2026-11-25), main protected against force pushes and deletion. Required reviews need a second person.
4. Enable **MFA** on the GitHub account(s).
5. ~~Public release~~: done, `v0.2.0-rc.4` (https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.4), labelled Authenticode-unsigned; the download page points at it.
6. Apply at https://signpath.org/apply with section 3; disclose the items marked "risk" and "to confirm".
7. After acceptance: in SignPath create the project, the artifact configurations from `.signpath/artifact-configurations/`, and a
   release signing policy with **manual approval**; enable MFA on SignPath.
8. In GitHub: secrets `SIGNPATH_API_TOKEN`, `PSO_RELEASE_SIGNING_KEY` (Ed25519 package key), `PSO_DENYLIST`; variables
   `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, and finally `PSO_SIGNPATH_ENABLED=true`; environment `release-signing` with required reviewers (exists: reviewer DevMboo, tags `v*.*.*`).
9. Pin the actions in `.github/workflows/signpath-release.yml` by commit SHA; push a FINAL version tag (for example `v0.2.0`; release-candidate tags do not trigger the workflow); approve the two signing requests.
10. Validate the signed installer with `scripts/psd/validate/signed-sac.mjs` on an isolated Windows 11 VM with Smart App Control On.
11. Only then add SignPath's attribution line to the code signing policy page and change its status, and publish the release.

## 6. Final application answers (ready, not submitted)

The form at https://signpath.org/apply is filled from section 3 with these values; the disclosure text is section 3a.

| Question | Answer |
|---|---|
| Project / repository | PSO Web Framework, https://github.com/DevMboo/pso-web-framework |
| License | Apache-2.0 (OSI-approved) for every component; no dual licensing, no paid edition, no telemetry |
| What is signed | per release, two files built by the workflow on GitHub-hosted runners from the tagged commit: the Inno Setup uninstaller/self-copy and the installer `PSO-Web-<version>-win-x64.exe`; `node.exe` is never submitted |
| Latest public release | https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.4 (unsigned prerelease, the form a signed release will take) |
| Download page | https://devmboo.github.io/pso-web-docs/downloads/index.html |
| Code signing policy / privacy policy | https://devmboo.github.io/pso-web-docs/downloads/code-signing-policy.html, https://devmboo.github.io/pso-web-docs/downloads/privacy-policy.html |
| Team and roles | DevMboo: author, reviewer and approver (single maintainer) |
| Build | `.github/workflows/signpath-release.yml`, origin verification through GitHub artifact ids, manual approval of each request |
| Disclosures | section 3a: the `pso environment:network --verify` diagnostic, the optional OSV-Scanner integration, the Inno Setup runtime |

### 6a. Before pressing submit (owner)

1. Confirm MFA on the GitHub account `DevMboo` (not verifiable from this session) and create the SignPath account with MFA.
2. Re-read https://signpath.org/terms (it was marked "Draft" when reviewed) and compare it with section 1.
3. Submit; do not add the SignPath attribution line or change the code signing policy status before acceptance.

### 6b. Remaining eligibility concerns

- **Reputation** (main risk): the repository became public on 2026-11-25 and has no external users, stars or forks yet; SignPath publishes no threshold and may ask the project to wait.
- **Inno Setup runtime**: the uninstaller/self-copy submitted for signing is Inno Setup's compiled code under the Inno Setup License (permissive, not OSI-listed). Ask SignPath whether signing it is acceptable; the alternative is an installer technology built from OSI-licensed source.
- **Network diagnostic**: `pso environment:network --verify` opens one TCP connection to each port the user's own server reported. It is not a scanner of ranges or foreign hosts, but it is the closest match to SignPath's "hacking tools" example: disclose it (section 3a).
- **Single maintainer**: one person holds every role; SignPath may ask for a second reviewer or approver.
- **Build provenance**: the rc.4 release was built on the maintainer's machine from the tagged commit, not by the workflow; a signed release must come from the workflow, and the release manifest does not yet record the source commit (the tag and release notes do).
