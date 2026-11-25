<#
.SYNOPSIS
  Installation assistant for PSO Web (Windows 10/11, x64). Project: PSO Web Framework - maintainer DevMboo (https://github.com/DevMboo) - Apache License 2.0

.DESCRIPTION
  Runs the official PSO Web installer that sits next to this script (or installs the portable ZIP) and gives it the one thing it needs to trust the
  release: the SIGNING FINGERPRINT that the PSO maintainer gave you through a different channel than the installer itself.

  This script NEVER takes the fingerprint from the installer. It does not turn off PSO's signature checks, Windows Defender, SmartScreen, Smart App
  Control or any company policy, and it does not use administrator rights.

.EXAMPLE
  .\Install-PSO-Web.ps1 -ExpectedSigner "7ebc ed00 6968 027b ..."

.EXAMPLE
  .\Install-PSO-Web.ps1 -PortableZip .\PSO-Web-0.1.0-alpha.2-win-x64-portable.zip -PortableDir C:\Tools\pso -ExpectedSha256 <checksum from the maintainer>
#>
[CmdletBinding()]
param(
  # The installer to run. Default: the only PSO-Web-*-win-x64.exe next to this script.
  [string]$InstallerPath,
  # 64-character signing fingerprint obtained from the maintainer (spaces or colons are fine).
  [string]$ExpectedSigner,
  # SHA-256 of the installer or ZIP, obtained from the maintainer (not from the same download page).
  [string]$ExpectedSha256,
  # Folder to install into (default: the installer's own default, inside your user profile).
  [string]$InstallDir,
  # Run the installer without its wizard pages.
  [switch]$Quiet,
  # Install the portable ZIP instead of running the installer.
  [string]$PortableZip,
  # Where to extract the portable ZIP (a new folder is created inside it).
  [string]$PortableDir,
  # Portable only: add its bin folder to YOUR user PATH. Never done unless you ask.
  [switch]$AddToPath,
  # Alpha 1 only: continue although a prerequisite check failed (the installer itself will still refuse if it must).
  [switch]$Force
)

# Filled in by the maintainer ONLY when this script itself is delivered through a channel that the maintainer authenticates
# (for example a download from the project's official release page over HTTPS, or a signed message). Left empty otherwise.
$PreconfiguredSignerFingerprint = ''
$PreconfiguredInstallerSha256 = ''

$ErrorActionPreference = 'Stop'
$script:AppUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}_is1'

# ------------------------------------------------------------------------------------------------ helpers
function Write-Step([string]$m) { Write-Host ('  ' + $m) }
function Write-Good([string]$m) { Write-Host ('  [ok] ' + $m) -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host ('  [!]  ' + $m) -ForegroundColor Yellow }
function Write-Bad([string]$m) { Write-Host ('  [x]  ' + $m) -ForegroundColor Red }

function Stop-Install([string]$Message, [int]$Code = 1) {
  $e = New-Object System.InvalidOperationException $Message
  $e.Data['PsoExitCode'] = $Code
  throw $e
}

function ConvertTo-Hex([string]$Text) { if ($null -eq $Text) { return '' } return (($Text -replace '[^0-9a-fA-F]', '').ToLowerInvariant()) }
function Group-Hex([string]$Hex) { return (($Hex -replace '(.{4})', '$1 ').Trim()) }
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Get-InstallerVersion([string]$Path) {
  $m = [regex]::Match([IO.Path]::GetFileName($Path), '^PSO-Web-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-win-x64(?:-portable)?\.(?:exe|zip)$')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

# The independent trust anchor: a fingerprint the person or the maintainer supplied. Never anything read out of the installer.
function Resolve-SignerAnchor([string]$FromParameter, [string]$Preconfigured) {
  $raw = $null; $source = $null
  if ($FromParameter) { $raw = $FromParameter; $source = 'the -ExpectedSigner value you gave' }
  elseif ($Preconfigured) { $raw = $Preconfigured; $source = 'the fingerprint configured in this script by the maintainer' }
  if (-not $raw) { return $null }
  $hex = ConvertTo-Hex $raw
  if ($hex.Length -ne 64) { Stop-Install ('The signing fingerprint must have exactly 64 hexadecimal characters (0-9, a-f); the one from ' + $source + ' has ' + $hex.Length + '. Copy it again from the maintainer''s message.') 1 }
  return [pscustomobject]@{ Hex = $hex; Source = $source }
}

function Resolve-Sha256Anchor([string]$FromParameter, [string]$Preconfigured) {
  $raw = if ($FromParameter) { $FromParameter } else { $Preconfigured }
  if (-not $raw) { return $null }
  $hex = ConvertTo-Hex $raw
  if ($hex.Length -ne 64) { Stop-Install ('The expected SHA-256 must have exactly 64 hexadecimal characters; the value given has ' + $hex.Length + '.') 1 }
  return $hex
}

function Test-FileChecksum([string]$Path, [string]$ExpectedHex) {
  $actual = Get-Sha256 $Path
  if ($ExpectedHex) {
    if ($actual -ne $ExpectedHex) { Stop-Install ('The file does not match the checksum the maintainer gave you, so it was not used.' + [Environment]::NewLine + '    expected: ' + $ExpectedHex + [Environment]::NewLine + '    found:    ' + $actual + [Environment]::NewLine + 'Download the file again from the official place; if it still differs, tell the maintainer.') 1 }
    Write-Good 'The file matches the checksum you were given.'
  } else {
    Write-Warn ('No expected checksum was given, so the file could not be checked against one. Its SHA-256 is ' + $actual + '. Compare it with the value the maintainer sends you.')
  }
  return $actual
}

function Find-Installer([string]$Explicit, [string]$Folder) {
  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { Stop-Install ('The installer was not found: ' + $Explicit) 1 }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }
  $found = @(Get-ChildItem -LiteralPath $Folder -Filter 'PSO-Web-*-win-x64.exe' -File -ErrorAction SilentlyContinue)
  if ($found.Count -eq 0) { Stop-Install ('No installer was found next to this script (' + $Folder + '). Put the file PSO-Web-<version>-win-x64.exe in the same folder as Install-PSO-Web.ps1 and run the script again.') 1 }
  if ($found.Count -gt 1) { Stop-Install ('More than one installer is in ' + $Folder + ' (' + (($found | ForEach-Object { $_.Name }) -join ', ') + '). Keep one, or choose with -InstallerPath.') 1 }
  return $found[0].FullName
}

# Alpha 1 facts (see README): it is encrypted for enrolled developers and needs Node.js 24+ on PATH.
function Test-LegacyPrerequisites([string]$Version, [switch]$Force) {
  if ($Version -ne '0.1.0-alpha.1') { return }
  $problems = @()
  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodeOk = $false
  if ($node) { try { $nv = (& $node.Source -p 'process.versions.node' | Select-Object -First 1).ToString().Trim(); $nodeOk = ([version]$nv).Major -ge 24 } catch { $nodeOk = $false } }
  if (-not $nodeOk) { $problems += 'Node.js 24 or newer is required on PATH by version 0.1.0-alpha.1 (this script cannot install it for you; alpha.2 includes its own).' }
  $home1 = if ($env:PSO_RECIPIENT_HOME) { $env:PSO_RECIPIENT_HOME } else { Join-Path $env:LOCALAPPDATA 'PSO\recipient' }
  if (-not (Test-Path -LiteralPath (Join-Path $home1 'identity.json'))) { $problems += 'Version 0.1.0-alpha.1 is encrypted for developers who were enrolled by the maintainer, and no personal PSO key was found on this computer. Ask the maintainer for the newer 0.1.0-alpha.2 release, which needs no enrollment.' }
  foreach ($p in $problems) { if ($Force) { Write-Warn ($p + ' (continuing because of -Force)') } else { Write-Bad $p } }
  if ($problems.Count -gt 0 -and -not $Force) { Stop-Install 'This installer cannot work on this computer yet. Nothing was installed.' 1 }
}

function Get-SmartAppControlState {
  try {
    $v = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState
    switch ($v) { 0 { return 'off' } 1 { return 'on' } 2 { return 'evaluation' } default { return 'unknown' } }
  } catch { return 'unknown' }
}

function Get-BlockExplanation([string]$Message, [int]$NativeCode) {
  $blocked = ($NativeCode -in 1260, 225, 1261, 4551) -or ($Message -match 'Application Control|Controle de Aplicativo|blocked|bloquead|bloqueou|group policy|pol.tica|virus|v.rus')
  if (-not $blocked) { return $null }
  $sac = Get-SmartAppControlState
  $t = 'Windows (or your organization''s security policy) refused to start the installer. This script does not bypass that.' + [Environment]::NewLine +
       '    - Do not turn security features off to get around this.' + [Environment]::NewLine +
       '    - The installer is not digitally signed, which Smart App Control (Windows 11) and many company policies do not allow.' + [Environment]::NewLine +
       '    - Ask the maintainer for a signed installer, or ask your IT administrator to approve this exact file.'
  if ($sac -eq 'on' -or $sac -eq 'evaluation') { $t += [Environment]::NewLine + '    - Smart App Control state on this computer: ' + $sac + '.' }
  return $t
}

# Starts the installer and waits. $Starter exists so the logic can be tested; the default really starts the program.
function Invoke-Installer([string]$Path, [string[]]$Arguments, [scriptblock]$Starter) {
  if (-not $Starter) {
    $Starter = { param($p, $a) $proc = Start-Process -FilePath $p -ArgumentList $a -PassThru -Wait; return $proc.ExitCode }
  }
  try { return [int](& $Starter $Path $Arguments) }
  catch {
    $native = 0
    if ($_.Exception -is [System.ComponentModel.Win32Exception]) { $native = $_.Exception.NativeErrorCode }
    $why = Get-BlockExplanation $_.Exception.Message $native
    if ($why) { Stop-Install ($why + [Environment]::NewLine + '    (Windows said: ' + $_.Exception.Message.Trim() + ')') 3 }
    Stop-Install ('The installer could not be started: ' + $_.Exception.Message.Trim()) 1
  }
}

$script:CodeText = @{
  'NO_TRUST_ANCHOR'     = 'PSO had no way to confirm who made this installer.'
  'SIGNER_MISMATCH'     = 'The signing fingerprint you gave does NOT match this installer. The installer may have been replaced or changed, or the fingerprint was copied wrongly. Do not use it; contact the maintainer.'
  'SIGNER_NOT_TRUSTED'  = 'This installer is signed by a key that this computer or an existing PSO installation does not trust. Ask the maintainer whether the signing key changed and for the new fingerprint.'
  'FINGERPRINT_INVALID' = 'The fingerprint was not accepted by the installer (it must be 64 hexadecimal characters).'
  'NO_IDENTITY'         = 'This release is encrypted for enrolled developers and this computer has no PSO key. Ask the maintainer for a release you can install.'
  'NOT_AUTHORIZED'      = 'This release was not prepared for your PSO key. Ask the maintainer to include you.'
  'PSOPKG_SIGNATURE'    = 'The installer''s package failed its signature check: it is damaged or was modified. Download it again; if it fails again, contact the maintainer.'
  'PSOPKG_FORMAT'       = 'The installer''s package is damaged. Download it again.'
}
function Get-InstallerFailureText([string]$LogPath) {
  if (-not $LogPath -or -not (Test-Path -LiteralPath $LogPath)) { return $null }
  $text = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
  if (-not $text) { return $null }
  $m = [regex]::Match($text, 'error:\s*([A-Z0-9_]+):')
  if ($m.Success) {
    $explained = $script:CodeText[$m.Groups[1].Value]
    if (-not $explained) { $explained = 'The installer stopped for a reason it reported as ' + $m.Groups[1].Value + '.' }
    return ($explained + ' (code ' + $m.Groups[1].Value + ')')
  }
  if ($text -match 'Node\.js 24') { return 'This installer needs Node.js 24 or newer on PATH.' }
  return $null
}

function Get-InstalledRoot([string]$FallbackDir) {
  try { $p = (Get-ItemProperty -Path $script:AppUninstallKey -ErrorAction Stop).'Inno Setup: App Path'; if ($p) { return $p } } catch { }
  return $FallbackDir
}

# Runs `pso --version` the way the installed layout allows, and says honestly what is missing.
function Test-InstalledCli([string]$Root, [switch]$Portable) {
  $r = [ordered]@{ Ok = $false; Version = $null; Notes = @() }
  if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { $r.Notes += 'The installation folder was not found.'; return [pscustomobject]$r }
  $cmd = Join-Path $Root 'bin\pso.cmd'
  if (Test-Path -LiteralPath $cmd) {
    $out = & $env:ComSpec /d /c ('"' + $cmd + '" --version') 2>&1
    if ($LASTEXITCODE -eq 0 -and ($out -join ' ') -match '\d+\.\d+\.\d+') { $r.Ok = $true; $r.Version = (($out | Select-Object -First 1) -as [string]).Trim() }
    else { $r.Notes += ('pso.cmd ran but did not print a version: ' + ($out -join ' ')) }
    return [pscustomobject]$r
  }
  # installers before alpha.2 create no launcher: run the installed CLI directly with the Node.js on PATH, and say so
  $state = Join-Path $Root '.pso-install\install.json'
  if (Test-Path -LiteralPath $state) {
    $cur = (Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).current
    $js = if ($cur) { Join-Path $Root ('versions\' + $cur + '\node_modules\@pso\cli\bin\pso.js') } else { $null }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($js -and (Test-Path -LiteralPath $js) -and $node) {
      $out = & $node.Source $js --version 2>&1
      if ($LASTEXITCODE -eq 0 -and ($out -join ' ') -match '\d+\.\d+\.\d+') { $r.Ok = $true; $r.Version = ($out | Select-Object -First 1).ToString().Trim() }
    }
    $r.Notes += 'This installer version did not create the "pso" command: there is no bin\pso.cmd in the installation folder, so typing pso in a new terminal will not work. This is a known limit of version 0.1.0-alpha.1 fixed in 0.1.0-alpha.2.'
  } else { $r.Notes += 'PSO does not appear to be installed in that folder (no installation record).' }
  return [pscustomobject]$r
}

# ------------------------------------------------------------------------------------------------ portable ZIP
function Expand-PsoZip([string]$ZipPath, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $full = [IO.Path]::GetFullPath($Destination)
  $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 100000) { Stop-Install 'The ZIP has an unexpected number of files; it was not extracted.' 1 }
    $total = 0L; foreach ($e in $zip.Entries) { $total += $e.Length }
    if ($total -gt 2GB) { Stop-Install 'The ZIP expands to an unexpectedly large size; it was not extracted.' 1 }
    foreach ($e in $zip.Entries) {
      $name = $e.FullName
      if ($name -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($name) -or $name -match '^[A-Za-z]:') { Stop-Install ('The ZIP contains an unsafe path (' + $name + ') and was not extracted.') 1 }
      $target = [IO.Path]::GetFullPath((Join-Path $full $name))
      if (-not $target.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Stop-Install ('The ZIP tries to write outside the target folder (' + $name + '); it was not extracted.') 1 }
      if ($name.EndsWith('/') -or $name.EndsWith('\')) { [void][IO.Directory]::CreateDirectory($target); continue }
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $false)
    }
  } finally { $zip.Dispose() }
}

function Get-PemFingerprint([string]$PemPath) {
  $b64 = ((Get-Content -LiteralPath $PemPath -Raw) -replace '-----[^-]+-----', '' -replace '\s', '')
  $der = [Convert]::FromBase64String($b64)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($der) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}

function Install-PortableZip([string]$Zip, [string]$ParentDir, $SignerAnchor, [string]$Sha256Anchor, [switch]$AddPath) {
  if (-not (Test-Path -LiteralPath $Zip -PathType Leaf)) { Stop-Install ('The ZIP was not found: ' + $Zip) 1 }
  if (-not $SignerAnchor -and -not $Sha256Anchor) { Stop-Install ('Cannot confirm where this ZIP comes from. Give -ExpectedSha256 (the checksum the maintainer sent you separately) or -ExpectedSigner (the signing fingerprint), then run the script again. Nothing was extracted.') 1 }
  [void](Test-FileChecksum $Zip $Sha256Anchor)
  if (-not $ParentDir) { Stop-Install 'Choose where to put PSO with -PortableDir <folder> (for example C:\Tools\pso). A new folder is created inside it; nothing existing is overwritten.' 1 }
  $parent = [IO.Path]::GetFullPath($ParentDir)
  [void][IO.Directory]::CreateDirectory($parent)
  $staging = Join-Path $parent ('.pso-extract-' + [guid]::NewGuid().ToString('N'))
  $final = $null
  try {
    Expand-PsoZip $Zip $staging
    $tops = @(Get-ChildItem -LiteralPath $staging -Directory)
    if ($tops.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $tops[0].FullName 'bin\pso.cmd'))) { Stop-Install 'The ZIP is not a PSO portable package (no bin\pso.cmd); it was removed.' 1 }
    $final = Join-Path $parent $tops[0].Name
    if (Test-Path -LiteralPath $final) { Stop-Install ('The folder ' + $final + ' already exists. Nothing was overwritten; choose another -PortableDir or remove it first.') 1 }
    if ($SignerAnchor) {
      $pems = @(Get-ChildItem -LiteralPath (Join-Path $tops[0].FullName '.pso-install\trust') -Filter '*.public.pem' -ErrorAction SilentlyContinue)
      $fps = @($pems | ForEach-Object { Get-PemFingerprint $_.FullName })
      if ($fps.Count -ne 1 -or $fps[0] -ne $SignerAnchor.Hex) { Stop-Install ('The signing key inside this ZIP (' + (($fps | ForEach-Object { Group-Hex $_ }) -join '; ') + ') is not the fingerprint you gave (' + (Group-Hex $SignerAnchor.Hex) + '). It was removed and not used.') 1 }
      Write-Good 'The signing key inside the ZIP matches the fingerprint you were given.'
    }
    Move-Item -LiteralPath $tops[0].FullName -Destination $final
  } catch { throw } finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue } }
  if ($AddPath) {
    $bin = Join-Path $final 'bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (($cur -split ';') -notcontains $bin) { $key.SetValue('Path', ($(if ($cur) { $cur.TrimEnd(';') + ';' } else { '' }) + $bin), [Microsoft.Win32.RegistryValueKind]::ExpandString); Write-Good ('Added ' + $bin + ' to YOUR user PATH (new terminals only).') }
    } finally { $key.Close() }
  }
  return $final
}

# ------------------------------------------------------------------------------------------------ main
function Invoke-PsoInstall {
  Write-Host ''
  Write-Host 'PSO Web installation assistant' -ForegroundColor Cyan
  Write-Host '  Project: PSO Web Framework - maintainer DevMboo (https://github.com/DevMboo) - Apache License 2.0'
  Write-Host ''
  if ($env:OS -ne 'Windows_NT' -or [Environment]::OSVersion.Version.Major -lt 10) { Stop-Install 'PSO Web needs Windows 10 or Windows 11.' 1 }
  if (-not [Environment]::Is64BitOperatingSystem) { Stop-Install 'PSO Web needs a 64-bit (x64) Windows.' 1 }
  $signer = Resolve-SignerAnchor $ExpectedSigner $PreconfiguredSignerFingerprint
  $sha = Resolve-Sha256Anchor $ExpectedSha256 $PreconfiguredInstallerSha256
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

  if ($PortableZip) {
    Write-Host 'Portable installation' -ForegroundColor Cyan
    $root = Install-PortableZip $PortableZip $PortableDir $signer $sha -AddPath:$AddToPath
    Write-Good ('PSO was extracted to ' + $root)
    $cli = Test-InstalledCli $root -Portable
    if (-not $cli.Ok) { Stop-Install ('PSO was extracted but "pso --version" did not work. ' + ($cli.Notes -join ' ')) 1 }
    $int = & $env:ComSpec /d /c ('"' + (Join-Path $root 'bin\pso.cmd') + '" integrity check --full --root "' + $root + '"') 2>&1
    if ($LASTEXITCODE -ne 0) { Stop-Install ('PSO was extracted but its own integrity check failed: ' + ($int -join ' ')) 1 }
    Write-Good ('pso --version: ' + $cli.Version)
    Write-Good 'PSO''s integrity check passed.'
    Write-Host ''; Write-Host 'Done. To run PSO:' -ForegroundColor Cyan
    Write-Host ('    "' + (Join-Path $root 'pso.cmd') + '" --version')
    if (-not $AddToPath) { Write-Host '  To type just "pso", re-run with -AddToPath or add the bin folder to your own PATH.' }
    return 0
  }

  $installer = Find-Installer $InstallerPath $here
  $version = Get-InstallerVersion $installer
  Write-Step ('Installer: ' + $installer)
  Write-Step ('Version:   ' + $(if ($version) { $version } else { 'unknown (unrecognized file name)' }))
  if (-not $signer) {
    Stop-Install ('Cannot confirm who made this installer, so it will not be run.' + [Environment]::NewLine +
      '    The maintainer must give you the signing fingerprint through a DIFFERENT channel than the installer (a call, a message, the project website).' + [Environment]::NewLine +
      '    Then run:  .\Install-PSO-Web.ps1 -ExpectedSigner "<the fingerprint>"') 1
  }
  Write-Step ('Signing fingerprint accepted from ' + $signer.Source + '.')
  [void](Test-FileChecksum $installer $sha)
  Test-LegacyPrerequisites $version -Force:$Force
  $sac = Get-SmartAppControlState
  if ($sac -eq 'on') { Write-Warn 'Smart App Control is on. It may refuse to start an unsigned installer; if so you will get an explanation and nothing is changed.' }

  $log = Join-Path ([IO.Path]::GetTempPath()) ('pso-setup-' + [guid]::NewGuid().ToString('N') + '.log')
  $args1 = @(('/SIGNER=' + $signer.Hex), ('/LOG="' + $log + '"'))
  if ($InstallDir) { $args1 += ('/DIR="' + $InstallDir + '"') }
  if ($Quiet) { $args1 += @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') }
  $before = Test-Path -Path $script:AppUninstallKey
  if ($before) { Write-Warn 'PSO is already installed for your account; the installer will upgrade it (it keeps your data).' }
  Write-Step 'Starting the official installer. Follow its steps; this window waits.'
  $code = Invoke-Installer $installer $args1 $script:Starter
  $why = Get-InstallerFailureText $log
  if ($code -ne 0) {
    $msg = if ($why) { $why } else { 'The installer ended with code ' + $code + ' (it was cancelled or failed).' }
    Stop-Install ($msg + [Environment]::NewLine + '    Nothing new was left installed by this attempt.' + $(if (Test-Path -LiteralPath $log) { [Environment]::NewLine + '    Details: ' + $log } else { '' })) 1
  }
  $root = Get-InstalledRoot $InstallDir
  $cli = Test-InstalledCli $root
  foreach ($n in $cli.Notes) { Write-Warn $n }
  if (-not $cli.Ok) { Stop-Install ('The installer finished, but "pso --version" could not be confirmed (' + $root + ').') 1 }
  Write-Good ('PSO is installed in ' + $root)
  Write-Good ('pso --version: ' + $cli.Version)
  Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
  Write-Host ''; Write-Host 'Done. Open a NEW terminal and run:  pso --version' -ForegroundColor Cyan
  return 0
}

$script:Starter = $null
if ($MyInvocation.InvocationName -ne '.') {
  try { $rc = Invoke-PsoInstall; exit $rc }
  catch {
    Write-Host ''
    if ($_.Exception.Data.Contains('PsoExitCode')) { Write-Bad $_.Exception.Message; Write-Host ''; exit ([int]$_.Exception.Data['PsoExitCode']) }
    Write-Bad ('Unexpected problem: ' + $_.Exception.Message); Write-Host ''; exit 1
  }
}
