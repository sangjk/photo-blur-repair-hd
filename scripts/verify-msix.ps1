<#
  verify-msix.ps1 - Gate G1: unpack the built MSIX and check Store compliance.

  Why this exists
  ---------------
  The MSIX is the only artifact that can bounce back from Microsoft certification
  with "10.1.2.10 The product crashes at launch / Error Message: N/A". The root
  cause of that class of failures in this project was the manifest EntryPoint
  (must be Windows.FullTrustApplication), plus a few more submission blockers
  (identity, 4-segment version, languages, missing assets, VC++ runtime deps).

  This gate inspects the ACTUAL package that will be uploaded - not the source
  manifest, not "it runs fine locally". Any FAIL exits with code 1 so the
  pipeline stops before a Release is published.

  Checks
  ------
   1. AppxManifest.xml present and well-formed
   2. Identity Name / Publisher non-empty and free of TODO_ placeholders
   3. EntryPoint: exactly the legal values, no Windows.FullTrustProcess anywhere
      (XML comments stripped before scanning)
   4. rescap:runFullTrust + TargetDeviceFamily Windows.Desktop
   5. ProcessorArchitecture x64, Identity@Version in 4 segments
   6. Resource languages non-empty (and covering zh-CN + en-US)
   7. MaxVersionTested >= 10.0.26100.0
   8. Every Assets\*.png referenced by the manifest exists in the package
   9. Store logo pixel sizes exact: StoreLogo 50, Square44x44Logo 44, Square150x150Logo 150
  10. Payload app.exe present; must NOT depend on VCRUNTIME140 / MSVCP140 /
      WebView2Loader (an MSIX has no installer to put the VC++ runtime in place)
  11. WEBVIEW2_USER_DATA_FOLDER must NOT be back (pit #16: that override was a
      wrong fix, it breaks other products sharing the folder and never fixed
      the certification failure)

  ASCII only on purpose: Windows PowerShell 5.1 mis-decodes UTF-8-without-BOM
  scripts, which has broken this project before.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$MsixPath,
  [string]$OutFile = "target/msix-conformance.txt"
)

$ErrorActionPreference = "Stop"

$results = New-Object System.Collections.Generic.List[string]
$failures = New-Object System.Collections.Generic.List[string]

function Check($ok, $name, $detail) {
  if ($ok) { $results.Add("PASS  $name - $detail") }
  else { $results.Add("FAIL  $name - $detail"); $failures.Add("${name}: ${detail}") }
}

if (-not (Test-Path $MsixPath)) { throw "MSIX not found: $MsixPath" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $MsixPath).Path)
try {
  $names = @($zip.Entries | ForEach-Object { $_.FullName })
  $manEntry = $zip.Entries | Where-Object { $_.FullName -eq "AppxManifest.xml" } | Select-Object -First 1
  $exeEntry = $zip.Entries | Where-Object { $_.FullName -eq "app.exe" } | Select-Object -First 1

  Check ($null -ne $manEntry) "manifest-present" "AppxManifest.xml exists in package"
  Check ($null -ne $exeEntry) "payload-exe" "app.exe exists in package"
  if (-not $manEntry) { throw "AppxManifest.xml missing - cannot continue" }

  $reader = New-Object System.IO.StreamReader($manEntry.Open())
  $manifest = $reader.ReadToEnd()
  $reader.Dispose()
} finally {
  $zip.Dispose()
}

# strip XML comments so a commented-out wrong EntryPoint cannot slip through
$raw = [regex]::Replace($manifest, '(?s)<!--.*?-->', '')

# --- 2. identity -------------------------------------------------------------
$nameM = [regex]::Match($raw, 'Identity[^>]*Name="([^"]*)"')
$pubM = [regex]::Match($raw, 'Identity[^>]*Publisher="([^"]*)"')
$verM = [regex]::Match($raw, 'Identity[^>]*Version="([^"]*)"')
$archM = [regex]::Match($raw, 'Identity[^>]*ProcessorArchitecture="([^"]*)"')

Check ($nameM.Success -and $nameM.Groups[1].Value -notmatch 'TODO_' -and $nameM.Groups[1].Value.Length -gt 0) "identity-name" "Identity@Name = $($nameM.Groups[1].Value)"
Check ($pubM.Success -and $pubM.Groups[1].Value -like 'CN=*') "identity-publisher" "Identity@Publisher = $($pubM.Groups[1].Value)"
Check ($verM.Success -and (($verM.Groups[1].Value.Split('.')).Count -eq 4)) "identity-version" "Identity@Version = $($verM.Groups[1].Value) (must be 4 segments)"
Check ($archM.Success -and $archM.Groups[1].Value -eq 'x64') "identity-arch" "ProcessorArchitecture = $($archM.Groups[1].Value)"
Check ($raw -notmatch 'TODO_') "no-placeholders" "manifest has no TODO_ placeholders"

# --- 3. EntryPoint (certification 10.1.2.10 root cause) ----------------------
$eps = @([regex]::Matches($raw, 'EntryPoint="([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
$uniq = @($eps | Sort-Object -Unique)
Check ($eps.Count -ge 1) "entrypoint-present" "EntryPoint occurrences: $($eps.Count)"
Check (($uniq.Count -eq 1) -and ($uniq[0] -eq 'Windows.FullTrustApplication')) "entrypoint-value" "all EntryPoint = $($uniq -join ', ')"
Check ($raw -notmatch 'Windows\.FullTrustProcess') "no-fulltrustprocess" "manifest contains no Windows.FullTrustProcess"

# --- 4. capabilities ---------------------------------------------------------
Check ($raw -match 'rescap:Capability\s+Name="runFullTrust"') "run-full-trust" "rescap:runFullTrust declared"
Check ($raw -match 'TargetDeviceFamily[^>]*Name="Windows\.Desktop"') "target-device-family" "Windows.Desktop declared"

# --- 5. version tested -------------------------------------------------------
$maxV = [regex]::Match($raw, 'MaxVersionTested="([^"]*)"')
$okMax = $false
if ($maxV.Success) {
  try { $okMax = ([version]$maxV.Groups[1].Value) -ge ([version]"10.0.26100.0") } catch { $okMax = $false }
}
Check $okMax "max-version-tested" "MaxVersionTested = $($maxV.Groups[1].Value) (>= 10.0.26100.0 required)"

# --- 6. languages ------------------------------------------------------------
$langs = @([regex]::Matches($raw, '<Resource\s+Language="([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
Check ($langs.Count -gt 0) "languages-present" "Resources: $($langs -join ', ')"
Check (($langs -contains 'zh-CN') -and ($langs -contains 'en-US')) "languages-cover-store" "manifest languages cover the Store listing (zh-CN + en-US)"

# --- 7. assets referenced exist + store logo sizes ---------------------------
$refs = @([regex]::Matches($raw, 'Assets\\[A-Za-z0-9_\.\-]+\.png') | ForEach-Object { $_.Value } | Sort-Object -Unique)
Check ($refs.Count -gt 0) "assets-referenced" "manifest references $($refs.Count) asset(s)"
foreach ($ref in $refs) {
  $asset = $ref -replace '\\', '/'
  Check ($names -contains $asset) "asset-present $ref" "package contains $asset"
}

function Get-PngSize([byte[]]$bytes) {
  if ($null -eq $bytes -or $bytes.Length -lt 24) { return $null }
  $w = $bytes[16] * 16777216 + $bytes[17] * 65536 + $bytes[18] * 256 + $bytes[19]
  $h = $bytes[20] * 16777216 + $bytes[21] * 65536 + $bytes[22] * 256 + $bytes[23]
  return [pscustomobject]@{ W = $w; H = $h }
}

$expectedSizes = @{ 'StoreLogo.png' = 50; 'Square44x44Logo.png' = 44; 'Square150x150Logo.png' = 150 }
if (-not $env:RUNNER_TEMP) { $env:RUNNER_TEMP = [System.IO.Path]::GetTempPath() }
$extract = Join-Path $env:RUNNER_TEMP "msix-verify-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $extract | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $MsixPath).Path, $extract)
foreach ($kv in $expectedSizes.GetEnumerator()) {
  $p = Join-Path $extract ("Assets/" + $kv.Key)
  if (-not (Test-Path $p)) { Check $false "asset-size $($kv.Key)" "file missing"; continue }
  $size = Get-PngSize ([System.IO.File]::ReadAllBytes($p))
  Check (($null -ne $size) -and ($size.W -eq $kv.Value) -and ($size.H -eq $kv.Value)) "asset-size $($kv.Key)" "$($size.W)x$($size.H) (expected $($kv.Value)x$($kv.Value))"
}
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue

# --- 8. payload dependencies -------------------------------------------------
if ($exeEntry) {
  $zip2 = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $MsixPath).Path)
  try {
    $e2 = $zip2.Entries | Where-Object { $_.FullName -eq "app.exe" } | Select-Object -First 1
    # ZipArchiveEntry.CopyTo(Stream) does not exist on .NET Framework (PS 5.1):
    # open the entry stream and use Stream.CopyTo instead.
    $entryStream = $e2.Open()
    $ms = New-Object System.IO.MemoryStream
    $entryStream.CopyTo($ms)
    $entryStream.Dispose()
    $text = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())
  } finally { $zip2.Dispose() }

  foreach ($bad in @("VCRUNTIME140", "MSVCP140", "WebView2Loader")) {
    Check ($text -notmatch $bad) "payload-no-$bad" "app.exe does not depend on $bad"
  }
  Check ($text -notmatch "WEBVIEW2_USER_DATA_FOLDER") "payload-no-udf-override" "WEBVIEW2_USER_DATA_FOLDER override not reintroduced (pit #16)"
}

# --- report ------------------------------------------------------------------
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$header = @(
  "MSIX conformance report (gate G1)",
  "package: $MsixPath",
  "generated: $((Get-Date).ToUniversalTime().ToString('o'))",
  ""
)
$footer = if ($failures.Count -eq 0) { @("", "RESULT: PASS") } else { @("", "RESULT: FAIL", "problems:") + ($failures | ForEach-Object { "  - $_" }) }
[System.IO.File]::WriteAllLines($OutFile, ($header + $results + $footer))
$results | ForEach-Object { Write-Host $_ }
if ($failures.Count -eq 0) {
  Write-Host "== MSIX conformance: PASS ($($results.Count) checks) - report: $OutFile"
  exit 0
}
Write-Host "== MSIX conformance: FAIL - $($failures.Count) problem(s) - report: $OutFile"
exit 1
