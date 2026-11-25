PSO Web - how to install
========================

You received a folder with these files. Keep them together:

  Install-PSO-Web.ps1                the installation helper (this is what you run)
  PSO-Web-<version>-win-x64.exe      the PSO Web installer
  (optional) PSO-Web-<version>-win-x64-portable.zip    a version that needs no installer

You also need ONE thing that is NOT in this folder: the "signing fingerprint".
It is a line of 64 letters and digits that the PSO maintainer sends you in a
separate message or call (not together with these files). It is how PSO makes
sure the installer really comes from the project and was not swapped on the way.
If you do not have it, ask the maintainer before you go on.
(If the maintainer already built it into the script, you do not need to type it.)

Windows 10 or Windows 11, 64-bit. You do not need to install Node.js, Java,
Git or anything else, and you do not need administrator rights.

TO INSTALL
----------
1. Open the folder in File Explorer, click the address bar, type  powershell
   and press Enter. A blue window opens in that folder.
2. Type this (paste the fingerprint from the maintainer between the quotes):

     .\Install-PSO-Web.ps1 -ExpectedSigner "PASTE THE FINGERPRINT HERE"

   If the maintainer also gave you a checksum, add it:  -ExpectedSha256 "..."
3. The PSO installer window opens. Follow its steps and click Finish.
4. The script tells you whether PSO works. Then open a NEW terminal and type:

     pso --version

PORTABLE VERSION (no installer)
-------------------------------
If you received the .zip file, use it instead; choose where PSO should go:

  .\Install-PSO-Web.ps1 -PortableZip .\PSO-Web-<version>-win-x64-portable.zip -PortableDir C:\Tools\pso -ExpectedSha256 "THE CHECKSUM FROM THE MAINTAINER"

Then run PSO with   C:\Tools\pso\<folder>\pso.cmd --version
Nothing else on your computer is changed. Add -AddToPath if you want to type
just  pso  later; it is only done when you ask for it, for your user only.

IF SOMETHING GOES WRONG
-----------------------
* "running scripts is disabled on this system": that is a Windows setting.
  On your OWN computer you can allow it for this window only:
     Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
  If it still refuses because the file came from the internet, right-click
  Install-PSO-Web.ps1, choose Properties, tick "Unblock" - only if you got the
  file from the maintainer. On a company computer, ask your IT department.
* "Windows refused to start the installer" / "blocked by an application control
  policy" / SmartScreen or Smart App Control warning: the installer is not
  digitally signed yet. Do NOT turn security features off. Ask the maintainer
  for a signed version, or ask your IT department to approve the installer.
  The portable .zip may work where the installer is blocked.
* "does not match" (fingerprint or checksum): the file or the number is wrong.
  Do not use the file. Download it again and check the number with the
  maintainer.
* Version 0.1.0-alpha.1 only: it needs Node.js 24 or newer already installed
  and a personal PSO key from the maintainer, and it does not create the
  "pso" command in new terminals. Ask for version 0.1.0-alpha.2 instead.

This is an early test version (alpha). Windows has not verified who published
it. Project: PSO Web Framework - maintainer DevMboo (https://github.com/DevMboo) - Apache License 2.0
