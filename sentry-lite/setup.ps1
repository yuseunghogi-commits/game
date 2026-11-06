<#
.SYNOPSIS
  Sentry-Lite installer for Windows (Windows PowerShell 5.1 or PowerShell 7+). No Docker, no admin rights.

.DESCRIPTION
  1. Finds Python >= 3.11 (py launcher or python.exe) and creates .venv
  2. pip-installs sentry-lite (+ semgrep, pytest, ruff, mypy) into .venv
  3. Downloads pinned gitleaks / osv-scanner Windows binaries into .\bin and verifies their SHA-256
     against the checksum file published with the same GitHub release
  4. Checks git (required) and Node.js + JDK 21 + firebase-tools (needed later for the Firebase emulator)
  5. Runs `sentry doctor`

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -SkipSemgrep      # if the semgrep wheel fails; see README (WSL2)
#>
[CmdletBinding()]
param(
    [string]$GitleaksVersion = "8.30.1",
    [string]$OsvScannerVersion = "2.7.0",
    [switch]$SkipSemgrep,
    [switch]$SkipBinaries,
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is 10x slower with the progress bar in PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = $PSScriptRoot
$Bin = Join-Path $Root "bin"
$Venv = Join-Path $Root ".venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
$Warnings = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow; $Warnings.Add($msg) }

# Run a native command without PS 5.1 turning stderr lines into terminating errors.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out -join "`n") }
    } catch {
        return [pscustomobject]@{ Code = 9009; Output = "$_" }
    } finally {
        $ErrorActionPreference = $old
    }
}

function Test-Command([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# --------------------------------------------------------------------------------------------- Python
Write-Step "Python >= 3.11"
$py = $null
$candidates = @(@("py", "-3.12"), @("py", "-3.11"), @("py", "-3.13"), @("py", "-3"), @("python"), @("python3"))
foreach ($c in $candidates) {
    if (-not (Test-Command $c[0])) { continue }
    $args2 = @()
    if ($c.Count -gt 1) { $args2 += $c[1..($c.Count - 1)] }
    $r = Invoke-Native $c[0] ($args2 + @("-c", "import sys; print('%d.%d' % sys.version_info[:2])"))
    if ($r.Code -ne 0 -or $r.Output -notmatch '^(\d+)\.(\d+)') { continue }
    $ver = [version]("$($Matches[1]).$($Matches[2])")
    if ($ver -ge [version]"3.11") { $py = $c; Write-Ok "$($c -join ' ') -> Python $ver"; break }
}
if (-not $py) {
    throw "Python 3.11+ not found. Install it with:  winget install Python.Python.3.12   (then reopen PowerShell)"
}

if ((Test-Path $VenvPy) -and -not $Force) {
    Write-Ok ".venv already exists (use -Force to recreate)"
} else {
    if (Test-Path $Venv) { Remove-Item -Recurse -Force $Venv }
    $pyArgs = @()
    if ($py.Count -gt 1) { $pyArgs += $py[1..($py.Count - 1)] }
    $r = Invoke-Native $py[0] ($pyArgs + @("-m", "venv", $Venv))
    if ($r.Code -ne 0) { throw "venv creation failed: $($r.Output)" }
    Write-Ok "created .venv"
}

Write-Step "pip install sentry-lite"
$r = Invoke-Native $VenvPy @("-m", "pip", "install", "--quiet", "--upgrade", "pip")
if ($r.Code -ne 0) { Write-Warn2 "pip upgrade failed (continuing): $($r.Output)" }
$extras = if ($SkipSemgrep) { "dev" } else { "scan,dev" }
$r = Invoke-Native $VenvPy @("-m", "pip", "install", "--quiet", "-e", "$Root[$extras]")
if ($r.Code -ne 0 -and -not $SkipSemgrep) {
    Write-Warn2 "semgrep could not be installed natively. Installing the rest; see README 'WSL2 fallback'."
    Write-Host $r.Output
    $r = Invoke-Native $VenvPy @("-m", "pip", "install", "--quiet", "-e", "$Root[dev]")
}
if ($r.Code -ne 0) { throw "pip install failed: $($r.Output)" }
Write-Ok "installed (extras: $extras)"

# ------------------------------------------------------------------------------------------- binaries
function Get-ReleaseAsset {
    param([string]$Repo, [string]$Tag, [string]$AssetPattern, [string]$SumsPattern)
    $api = "https://api.github.com/repos/$Repo/releases/tags/$Tag"
    $rel = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "sentry-lite-setup" }
    $asset = $rel.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
    $sums = $rel.assets | Where-Object { $_.name -match $SumsPattern } | Select-Object -First 1
    if (-not $asset) { throw "no asset matching '$AssetPattern' in $Repo $Tag" }
    if (-not $sums) { throw "no checksum file matching '$SumsPattern' in $Repo $Tag (refusing unverified download)" }
    return [pscustomobject]@{ Name = $asset.name; Url = $asset.browser_download_url; SumsUrl = $sums.browser_download_url }
}

function Save-Verified {
    param($Asset, [string]$Dest)
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("sentry-lite-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $file = Join-Path $tmp $Asset.Name
        Invoke-WebRequest -Uri $Asset.Url -OutFile $file -UseBasicParsing
        $sums = (Invoke-WebRequest -Uri $Asset.SumsUrl -UseBasicParsing).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        $line = ($sums -split "`n") | Where-Object { $_ -match ("\s\*?" + [regex]::Escape($Asset.Name) + "\s*$") } | Select-Object -First 1
        if (-not $line) { throw "checksum for $($Asset.Name) not listed" }
        $expected = ($line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
        if ($expected -ne $actual) { throw "SHA-256 mismatch for $($Asset.Name): expected $expected got $actual" }
        Write-Ok "$($Asset.Name) sha256 $actual verified"
        if ($Asset.Name -like "*.zip") {
            Expand-Archive -Path $file -DestinationPath $tmp -Force
            $exe = Get-ChildItem -Path $tmp -Recurse -Filter ((Split-Path $Dest -Leaf)) | Select-Object -First 1
            if (-not $exe) { throw "$(Split-Path $Dest -Leaf) not found inside $($Asset.Name)" }
            Copy-Item $exe.FullName $Dest -Force
        } else {
            Copy-Item $file $Dest -Force
        }
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

if (-not $SkipBinaries) {
    Write-Step "gitleaks v$GitleaksVersion and osv-scanner v$OsvScannerVersion -> .\bin"
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    $isArm = $env:PROCESSOR_ARCHITECTURE -eq "ARM64"
    $glArch = if ($isArm) { "arm64" } else { "x64" }
    $osvArch = if ($isArm) { "arm64" } else { "amd64" }
    $tools = @(
        @{ Name = "gitleaks"; Repo = "gitleaks/gitleaks"; Tag = "v$GitleaksVersion"; Want = $GitleaksVersion;
           Asset = "^gitleaks_.*_windows_$glArch\.zip$"; Sums = "checksums\.txt$"; Exe = "gitleaks.exe"; VerArgs = @("version") },
        @{ Name = "osv-scanner"; Repo = "google/osv-scanner"; Tag = "v$OsvScannerVersion"; Want = $OsvScannerVersion;
           Asset = "^osv-scanner_windows_$osvArch\.exe$"; Sums = "SHA256SUMS$"; Exe = "osv-scanner.exe"; VerArgs = @("--version") }
    )
    foreach ($t in $tools) {
        $dest = Join-Path $Bin $t.Exe
        if ((Test-Path $dest) -and -not $Force) {
            $v = Invoke-Native $dest $t.VerArgs
            if ($v.Output -match [regex]::Escape($t.Want)) { Write-Ok "$($t.Name) $($t.Want) already present"; continue }
        }
        try {
            $asset = Get-ReleaseAsset -Repo $t.Repo -Tag $t.Tag -AssetPattern $t.Asset -SumsPattern $t.Sums
            Save-Verified -Asset $asset -Dest $dest
            $v = Invoke-Native $dest $t.VerArgs
            Write-Ok "$($t.Name): $(($v.Output -split "`n")[0])"
        } catch {
            Write-Warn2 "$($t.Name) download failed: $_  (download it manually from https://github.com/$($t.Repo)/releases into .\bin)"
        }
    }
}

# --------------------------------------------------------------------------------- other prerequisites
Write-Step "Other prerequisites"
if (Test-Command "git") { Write-Ok ((Invoke-Native "git" @("--version")).Output) }
else { Write-Warn2 "git not found (required for ownership checks and history scanning): winget install Git.Git" }

if (Test-Command "node") {
    $nv = (Invoke-Native "node" @("--version")).Output.Trim()
    if ($nv -match '^v(\d+)' -and [int]$Matches[1] -ge 20) { Write-Ok "Node.js $nv" }
    else { Write-Warn2 "Node.js $nv is old; Firebase emulator needs 20+: winget install OpenJS.NodeJS.LTS" }
} else { Write-Warn2 "Node.js not found (needed for Firebase emulator in /verify): winget install OpenJS.NodeJS.LTS" }

if (Test-Command "java") {
    $jv = (Invoke-Native "java" @("-version")).Output
    if ($jv -match 'version "(\d+)') {
        if ([int]$Matches[1] -ge 21) { Write-Ok "Java $($Matches[1])" }
        else { Write-Warn2 "Java $($Matches[1]) found; Firebase emulator needs JDK 21+: winget install EclipseAdoptium.Temurin.21.JDK" }
    } else { Write-Warn2 "could not parse 'java -version' output: $jv" }
} else { Write-Warn2 "JDK 21 not found (needed for Firestore emulator): winget install EclipseAdoptium.Temurin.21.JDK" }

if (Test-Command "firebase") { Write-Ok ("firebase-tools " + (Invoke-Native "firebase" @("--version")).Output.Trim()) }
else { Write-Warn2 "firebase-tools not found (needed for /verify against the emulator): npm install -g firebase-tools" }

# ------------------------------------------------------------------------------------------- doctor
Write-Step "sentry doctor"
$sentryExe = Join-Path $Venv "Scripts\sentry.exe"
$d = Invoke-Native $sentryExe @("doctor")
Write-Host $d.Output

Write-Host ""
if ($Warnings.Count -gt 0) {
    Write-Host "Finished with $($Warnings.Count) warning(s):" -ForegroundColor Yellow
    $Warnings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
} else {
    Write-Host "All set." -ForegroundColor Green
}
Write-Host @"

Next:
  .\.venv\Scripts\Activate.ps1
  sentry scan C:\path\to\your-repo
  sentry findings list
"@
