# Licensing status

## PSO Web Framework

**Apache License 2.0** (decided by the owner on 2026-11-25). `LICENSE` holds the official, unmodified text
(SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, from https://www.apache.org/licenses/LICENSE-2.0.txt) and
`NOTICE` the project notice. Every PSO npm package declares `"license": "Apache-2.0"` and ships both files; the Maven parent POM and the BOM
declare Apache-2.0, the maintainer (DevMboo) and the project URL; the Windows distribution installs both files (`licenses/`) and every
release directory carries them. PSO Web Framework is free and open-source software; there is no payment, activation or license-key
mechanism.

## Third-party components

| Distributed with PSO | License | Obligation and how it is met |
|---|---|---|
| npm production dependencies in the distribution (bundled under `node_modules/`) | MIT, Apache-2.0, BSD-3-Clause, ISC | license texts reproduced in `THIRD-PARTY-NOTICES.txt` of every release; none of the Apache-2.0 dependencies ships a NOTICE file (checked 2026-11-25) |
| Node.js runtime (`node.exe`, Windows distribution) | MIT, with the licenses of its bundled components | unmodified, OpenJS-signed binary; its `LICENSE` installed as `runtime/LICENSE-node.txt` and appended to `THIRD-PARTY-NOTICES.txt` |
| Inno Setup runtime (setup program and uninstaller inside the Windows installer) | Inno Setup License (permissive; not an OSI-listed license) | redistribution of installers is permitted; its copyright notices and web site addresses stay in the binaries (not modified); acknowledged in `NOTICE` |
| PSO Java artifacts in the bundled Maven repository | Apache-2.0 (PSO) | only `com.pso` artifacts are bundled; third-party Java libraries are resolved by the user's own build from Maven Central |

Java libraries the PSO starters depend on (resolved by the user's build, not redistributed by PSO) are inventoried per release in
`sbom-java.cdx.json`: mostly Apache-2.0, plus EPL-1.0/2.0, MPL-2.0, BSD, MIT, LGPL-2.1 and GPL-2.0 with the Classpath Exception. The one
dependency reported with "GPL v2" (`com.rabbitmq:amqp-client`) is triple-licensed Apache-2.0 / GPL-2.0 / MPL-2.0; the component reported
without a license was PSO's own `pso-bom`, which now declares Apache-2.0.

Project templates generate the user's own code; generated projects carry no PSO license header and are not relicensed.

Nothing in this file is legal advice.
