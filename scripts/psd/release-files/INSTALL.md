# Installing PSO Web {{LABEL}} (Private Developer Preview)

This release is encrypted for the developers the maintainer authorized. You create your own key; nobody else ever sees your private key.

**You need:** Windows 10/11 x64 and Node.js 24 or newer on your PATH (`node -v`). No administrator rights are needed, and none should be used: install as the same Windows account that will use PSO.

## 1. Check what you received

The release folder contains the installer, `pso-recipient.mjs` (your key utility), `release-manifest.json`, `SHA256SUMS` and its signature `SHA256SUMS.sig`, `release-signing-key.public.pem`, the dependency inventory and notices, and the documentation.

* The maintainer tells you the **signing key fingerprint** through a **different channel** than the one that delivered these files (a call, a message app). It is the value `signing.fingerprintSha256` in `release-manifest.json`.
* Print the fingerprint of the key you received and compare it, character by character:

  ```
  node pso-recipient.mjs show      (after step 2)   or:   node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(c.createPublicKey(f.readFileSync('release-signing-key.public.pem')).export({type:'spki',format:'der'})).digest('hex'))"
  ```

* If they differ, stop and tell the maintainer. Do not install.
* The installer is **not Authenticode-signed**, so Windows may show an unknown-publisher warning. That is expected for this preview; the signature and checksum above are how you verify it.

## 2. Create your key (once per Windows account)

```
node pso-recipient.mjs init --label "Your Name"
```

This creates a key pair on **your** machine. The private key is protected by Windows DPAPI for your account only, and it never leaves your machine. It writes `Your_Name.enrollment.json`, which contains only your public key and its fingerprint.

* Send **only** the enrollment file to the maintainer. Read the fingerprint it prints to the maintainer over a different channel; the maintainer compares it before authorizing you.
* Make a backup now: `node pso-recipient.mjs backup --out my-pso-key.backup.json` (it asks for a passphrase of 12 or more characters). Keep the backup and its passphrase in different places.
* `node pso-recipient.mjs doctor` tells you which account you are using and whether DPAPI works for it.

## 3. Install (first installation on this computer)

Have the signing key fingerprint from step 1 ready: the installer needs it and will not install without it. PSO cannot tell by itself who made an installer (a key inside a downloaded file proves nothing), so you supply the fingerprint you got from the maintainer through the other channel, and the installer checks that it is the key this installer was signed with.

**Double-click** `PSO-Web-{{LABEL}}-win-x64.exe`. After you choose the folder, the **Confirm the publisher key** page asks for the fingerprint: paste the 64 characters (spaces, colons and upper case are fine). The page deliberately does not show the installer's own key. If it says the fingerprint does not match, **stop**: the file was replaced or modified, or the fingerprint was copied wrongly. Nothing is installed.

* Tick *Remember this publisher key on this computer* only if you want later installers signed by the same key to skip the question.
* If you already pinned the key (below), or PSO is already installed there with this signer, the page is skipped.

**Silent install** (the fingerprint is mandatory, there is no page to ask):

```
PSO-Web-{{LABEL}}-win-x64.exe /VERYSILENT /SUPPRESSMSGBOXES /DIR=C:\Tools\pso /LOG=setup.log /SIGNER=<64-character fingerprint>
```

Add `/PINSIGNER=1` to remember the key as well. With `/LOG=` the refusal reason is in the log.

**Optional: pin once, never type it again.** `node pso-recipient.mjs pin-signer --fingerprint <fingerprint> --label "PSO release"` works on a clean machine (you do not need a key of your own for a public release). `node pso-recipient.mjs signers` lists what you trust; `node pso-recipient.mjs unpin-signer --fingerprint <fp>` removes one.

If it refuses, the message says why and **nothing is installed** (the folder is not even created):

| Code | Meaning and what to do |
|---|---|
| `NO_TRUST_ANCHOR` | no fingerprint was given and none is pinned: get it from the maintainer and enter it as above |
| `SIGNER_MISMATCH` | the fingerprint you gave is not this installer's key: do not install, ask the maintainer |
| `SIGNER_NOT_TRUSTED` | not a signer you pinned or this installation trusts; after a key rotation give the NEW fingerprint the maintainer announced |
| `NOT_AUTHORIZED` | the release was not encrypted for your key |
| `NO_IDENTITY` | encrypted release and no key of yours: do step 2 |
| `PSOPKG_SIGNATURE` | the package was modified or damaged |

To add PSO to your PATH, tick the option in the installer (or add `<install dir>\bin`).

Then, in a new terminal:

```
pso doctor
pso integrity check --full --root C:\Tools\pso
```

## Updates and key rotation

After the first installation, PSO keeps the signer you confirmed inside the installation and `pso update` accepts only packages signed by it. If the maintainer **rotates** the signing key, a package signed by the new key is refused until you confirm the new fingerprint (announced through the independent channel): run the new installer and give it (page or `/SIGNER=`). Afterwards retire the old key with `unpin-signer`.

## Keeping it healthy

* `pso integrity check --full --root <dir>` verifies installed files against the signed inventory; `pso repair --root <dir>` restores damaged files from the authenticated package kept next to the installation (it needs your key, which is opened only when needed).
* `pso update check|install|rollback` handles later releases the same way.
* Uninstall from Windows Settings, or `pso uninstall --complete --yes --root <dir>`. Your own projects are never removed unless you name them with `--purge`.

## If something changes

| Situation | What to do |
|---|---|
| you lost your key and have no backup | run step 2 again and send the new enrollment file; releases encrypted for the old key cannot be opened |
| new Windows account, reinstalled Windows or a new computer | `node pso-recipient.mjs restore --file my-pso-key.backup.json`, or enroll again |
| the installer was started "as administrator" with another account | run it as the account that created the key |
| you are removed from the recipients | future releases will not open for you; releases you already installed keep working |

## Limits you should know

This preview raises the effort of copying or reverse engineering the framework; it cannot make local software immune to someone who runs it on their own computer. Your own projects (generated applications, controllers, services, DTOs, configuration) are yours: they stay readable and editable.
