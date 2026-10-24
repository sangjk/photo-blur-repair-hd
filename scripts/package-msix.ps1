<#
  package-msix.ps1 - Build an unsigned MSIX (Microsoft Store identity) from the
  Tauri release exe. Runs on GitHub Actions windows-latest (Windows SDK's
  makeappx.exe is preinstalled). The Store signs the package on submission,
  so we never call signtool here.

  Usage (from repo root):
    powershell -File scripts/package-msix.ps1 -ExePath "src-tauri/target/release/base-window.exe"

  What it does:
    1. Read productName / version from src-tauri/tauri.conf.json
       (version is padded to 4 segments, e.g. "1.0.0" -> "1.0.0.0", and written
        into the staged AppxManifest Identity@Version so they never drift)
    2. Fail fast if AppxManifest still contains TODO_ placeholders
    3. Stage layout: patched AppxManifest + app.exe + Assets (Store logos)
    4. Pack with makeappx.exe -> <OutDir>\<productName>-<version>-x64.msix
#>
[CmdletBinding()]
param(
  # Optional: when omitted the script auto-discovers the release exe
  # (never hardcode the exe name - renaming productName breaks a hardcoded path,
  #  see AGENT.md pit #19)
  [string]$ExePath = "",

  [string]$ManifestPath = "src-tauri/msix/AppxManifest.xml",
  [string]$IconsDir = "src-tauri/icons",
  [string]$TauriConfPath = "src-tauri/tauri.conf.json",
  [string]$OutDir = "target/msix",
  [string]$LayoutDir = "target/msix-layout"
)

$ErrorActionPreference = "Stop"

# Resolve relative paths against the repo root (parent of scripts/), not cwd
$RepoRoot = Split-Path -Parent $PSScriptRoot
function Resolve-Repo([string]$p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return $p } else { return (Join-Path $RepoRoot $p) }
}
if ($ExePath) { $ExePath = Resolve-Repo $ExePath }
$ManifestPath = Resolve-Repo $ManifestPath
$IconsDir = Resolve-Repo $IconsDir
$TauriConfPath = Resolve-Repo $TauriConfPath
$OutDir = Resolve-Repo $OutDir
$LayoutDir = Resolve-Repo $LayoutDir

# --- 1. Read product name + version from tauri.conf.json -------------------
if (-not (Test-Path $TauriConfPath)) { throw "tauri.conf.json not found: $TauriConfPath" }
$conf = Get-Content $TauriConfPath -Raw -Encoding UTF8 | ConvertFrom-Json
$productName = [string]$conf.productName
$rawVersion = [string]$conf.version
if (-not $productName) { throw "productName missing in tauri.conf.json" }
if (-not $rawVersion) { throw "version missing in tauri.conf.json" }

# MSIX version must be 4 segments (1.0.0 -> 1.0.0.0)
$parts = $rawVersion.Split(".")
while ($parts.Count -lt 4) { $parts += "0"; $parts = $parts | ForEach-Object { $_ } }
$msixVersion = ($parts | Select-Object -First 4) -join "."

# Sanitize product name for file naming (keep CJK letters, drop path-illegal chars)
$safeName = ($productName -replace '[\\/:*?"<>|]', "").Trim()
if (-not $safeName) { $safeName = "app" }
$msixFile = Join-Path $OutDir "$safeName-$rawVersion-x64.msix"

Write-Host "== MSIX packaging: $productName v$rawVersion (manifest version $msixVersion)"

# --- 2. Preflight checks ----------------------------------------------------
# Auto-discover the payload exe when -ExePath was not supplied
if (-not $ExePath) {
  $candidates = @(Get-ChildItem (Resolve-Repo "src-tauri/target/release") -Filter "*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending)
  if ($candidates.Count -eq 0) { throw "no release exe found under src-tauri/target/release (run 'npx tauri build --bundles nsis' first)" }
  $ExePath = $candidates[0].FullName
  Write-Host "==   exe auto-discovered: $ExePath"
}
if (-not (Test-Path $ExePath)) { throw "Release exe not found: $ExePath (run 'npx tauri build --bundles nsis' first)" }
if (-not (Test-Path $ManifestPath)) { throw "AppxManifest not found: $ManifestPath" }

# Strip XML comments before every check below: the manifest documents the WRONG
# EntryPoint ("Windows.FullTrustProcess") inside a comment as a warning to
# humans, and that literal text must not trip the gate. (Same rule as gate G1.)
$manifest = [regex]::Replace((Get-Content $ManifestPath -Raw -Encoding UTF8), '(?s)<!--.*?-->', '')
if ($manifest -match "TODO_") {
  throw "AppxManifest still contains TODO_ placeholders. Fill DisplayName/Description from TASK.md before packing."
}

# --- 2b. Store certification compliance gate --------------------------------
# Root cause of cert 10.1.2.10 "crashes at launch / Error Message: N/A" is a
# wrong EntryPoint, followed by missing runFullTrust / TargetDeviceFamily.
# All of them are hard-checked here: packing fails instead of shipping a
# package that Microsoft will bounce (see AGENT.md "10.1.2.10 problem family").
if ($manifest -notmatch 'EntryPoint="Windows\.FullTrustApplication"') {
  throw 'AppxManifest: Application@EntryPoint must be "Windows.FullTrustApplication" (packaged Win32 apps) - Store cert 10.1.2.10 launch crash root cause.'
}
if ($manifest -match 'Windows\.FullTrustProcess') {
  throw 'AppxManifest: invalid EntryPoint "Windows.FullTrustProcess" found - it must be "Windows.FullTrustApplication".'
}
if ($manifest -notmatch '<rescap:Capability\s+Name="runFullTrust"') {
  throw 'AppxManifest: <rescap:Capability Name="runFullTrust" /> is required for a packaged Win32 app.'
}
if ($manifest -notmatch 'TargetDeviceFamily[^>]*Name="Windows\.Desktop"') {
  throw 'AppxManifest: <TargetDeviceFamily Name="Windows.Desktop" /> is required.'
}
if ($manifest -notmatch 'Square150x150Logo=' -or $manifest -notmatch 'Square44x44Logo=') {
  throw 'AppxManifest: uap:VisualElements must declare Square150x150Logo and Square44x44Logo.'
}
try { $null = [xml]$manifest } catch { throw "AppxManifest is not well-formed XML: $($_.Exception.Message)" }

# EntryPoint must be globally unique: a half-fixed manifest (<Application> changed but
# the appExecutionAlias extension left behind) still fails activation at runtime.
$entryPoints = @([regex]::Matches($manifest, 'EntryPoint="([^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
if ($entryPoints.Count -ne 1) {
  throw "AppxManifest has inconsistent EntryPoint values: $($entryPoints -join ', ')."
}
if ($entryPoints[0] -ne 'Windows.FullTrustApplication') {
  throw "AppxManifest EntryPoint must be Windows.FullTrustApplication (found: $($entryPoints[0]))."
}
Write-Host "==   manifest gate passed (EntryPoint=$($entryPoints[0]), runFullTrust, Windows.Desktop)"

# --- 3. Stage layout --------------------------------------------------------
if (Test-Path $LayoutDir) { Remove-Item $LayoutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $LayoutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $LayoutDir "Assets") | Out-Null

# Patch Identity@Version (first match inside <Identity ...>) so it never drifts
$pattern = '(?s)(<Identity\b[^>]*?)Version="[^"]*"'
$patched = [regex]::Replace($manifest, $pattern, ('${1}Version="' + $msixVersion + '"'), 1)
if ($patched -notmatch [regex]::Escape('Version="' + $msixVersion + '"')) {
  throw "Failed to patch Identity@Version in AppxManifest"
}
# Patch the execution alias: it registers machine-wide, so a hardcoded
# "app.exe" collides with every other product installed on the same PC
# (AGENT.md pit #18). Derive it from the identifier's last segment.
$aliasSegment = ([string]$conf.identifier -split '\.')[-1]
if (-not $aliasSegment -or $aliasSegment -eq 'app') {
  throw "cannot derive a product-specific execution alias from identifier '$($conf.identifier)'"
}
$alias = "$aliasSegment.exe"
if ($patched -notmatch 'Alias="app\.exe"') { throw 'AppxManifest has no Alias="app.exe" to rewrite - check uap8:ExecutionAlias' }
$patched = [regex]::Replace($patched, 'Alias="app\.exe"', "Alias=""$alias""")
Write-Host "==   execution alias: $alias"

[System.IO.File]::WriteAllText((Join-Path $LayoutDir "AppxManifest.xml"), $patched, (New-Object System.Text.UTF8Encoding($false)))

# Payload exe: manifest Executable is fixed to "app.exe"
Copy-Item $ExePath (Join-Path $LayoutDir "app.exe") -Force
# Defensive: makeappx only reports "app.exe declared but missing" deep in its
# validation, so fail loudly right here if the copy did not produce a file.
$payload = Join-Path $LayoutDir "app.exe"
if (-not (Test-Path $payload -PathType Leaf)) { throw "payload exe was not staged as app.exe (source: $ExePath)" }
Write-Host "==   payload staged: app.exe ($([math]::Round((Get-Item $payload).Length / 1MB, 1)) MB)"

# Store logo assets referenced by the manifest
$assets = Get-ChildItem $IconsDir -Include "Square*.png", "StoreLogo.png" -Recurse
if (-not $assets) { throw "No Square*.png / StoreLogo.png found in $IconsDir" }
$assets | ForEach-Object { Copy-Item $_.FullName (Join-Path $LayoutDir ("Assets\" + $_.Name)) -Force }

# --- 3b. Asset completeness: every Assets\*.png referenced by the manifest ---
# must exist inside the package (a missing logo breaks install / certification)
$referenced = @([regex]::Matches($patched, 'Assets\\[A-Za-z0-9_\.\-]+\.png') | ForEach-Object { $_.Value })
if ($referenced.Count -eq 0) { throw 'AppxManifest references no Assets\*.png - manifest looks broken.' }
foreach ($ref in $referenced) {
  if (-not (Test-Path (Join-Path $LayoutDir $ref))) {
    throw "AppxManifest references missing asset: $ref (check src-tauri/icons)"
  }
}
Write-Host "==   assets verified: $($referenced.Count) referenced icon(s) present"

# --- 3c. Store logo pixel sizes (Submission rejects wrong-sized logos) -----
function Get-PngSizeLocal([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -lt 24) { return $null }
  $w = $bytes[16] * 16777216 + $bytes[17] * 65536 + $bytes[18] * 256 + $bytes[19]
  $h = $bytes[20] * 16777216 + $bytes[21] * 65536 + $bytes[22] * 256 + $bytes[23]
  return [pscustomobject]@{ W = $w; H = $h }
}
$expectedSizes = @{ 'StoreLogo.png' = 50; 'Square44x44Logo.png' = 44; 'Square150x150Logo.png' = 150 }
foreach ($kv in $expectedSizes.GetEnumerator()) {
  $p = Join-Path $IconsDir $kv.Key
  if (-not (Test-Path $p)) { throw "missing store logo: $($kv.Key) (expected in $IconsDir)" }
  $sz = Get-PngSizeLocal $p
  if ($null -eq $sz -or $sz.W -ne $kv.Value -or $sz.H -ne $kv.Value) {
    throw "wrong size for $($kv.Key): $($sz.W)x$($sz.H), expected $($kv.Value)x$($kv.Value)"
  }
}
Write-Host "==   store logo sizes verified (50/44/150)"

# --- 3d. Language set must cover every Store listing language (pit #21) ----
$langs = @([regex]::Matches($patched, '<Resource\s+Language="([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
if ($langs.Count -eq 0) { throw 'AppxManifest declares no <Resource Language> - Store submission will be rejected.' }
if (-not (($langs -contains 'zh-CN') -and ($langs -contains 'en-US'))) {
  throw "AppxManifest languages ($($langs -join ', ')) must cover the Store listing languages (zh-CN + en-US)."
}
Write-Host "==   language set verified: $($langs -join ', ')"

# --- 4. Pack with makeappx (unsigned; Store signs on ingestion) -------------
$makeappx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found (Windows SDK missing?)" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $msixFile) { Remove-Item $msixFile -Force }
& $makeappx.FullName pack /o /d $LayoutDir /p $msixFile /v
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

Write-Host "== MSIX created: $msixFile"
Write-Host "==   size: $((Get-Item $msixFile).Length / 1MB -as [int]) MB"
Write-Host "== Upload it to Partner Center (Submit -> New version). Microsoft signs it there."
# Emit path for CI (consume via: echo "MSIX_PATH=..." >> $GITHUB_ENV)
Write-Host "MSIX_PATH=$msixFile"
