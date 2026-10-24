<#
  msix-activation-selftest.ps1 - Gate G2: activate the package through the real
  Store launch path and require a VISIBLE main window.

  Why this exists
  ---------------
  Store certification reports "10.1.2.10 Functionality - The product crashes at
  launch" for packages that run fine everywhere locally. Directly executing the
  payload exe ALWAYS works (it inherits package identity when started from the
  package folder and bypasses activation), so "local runs fine" proves nothing.

  The only faithful check is to register the package and activate it through the
  real activation path (shell:AppsFolder\<AUMID>), then require a VISIBLE main
  window. That is exactly what this script does - the same A/B procedure that
  proved the manifest EntryPoint defect (bad -> 0/3 activations, fixed -> 3/3).

  Exit codes (deliberate, keeps CI usable but never silently passes):
    0  activation produced a visible main window  -> PASS
    1  AUMID exists but activation never shows a window -> FAIL (cert 10.1.2.10)
    2  environment cannot sideload / no AUMID -> SKIPPED (runner capability,
       not an app defect). CI must surface this as a warning, not a pass.

  ASCII only on purpose: Windows PowerShell 5.1 mis-decodes UTF-8-without-BOM
  scripts, which has bitten this project before.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$MsixPath,
  [string]$ExeName = "app",
  [int]$TimeoutSec = 20,
  [int]$Attempts = 3
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "== $m" }
function Warn($m) { Write-Warning $m }

# ---------------------------------------------------------------- enumerate windows
# EnumWindows + IsWindowVisible is required: the single-instance plugin creates a
# hidden helper window, so Process.MainWindowHandle/MainWindowTitle often point at
# the wrong window and would produce false positives.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  int ActivateApplication([In] string appUserModelId, [In] string arguments, [In] int options, [Out] out uint processId);
  int ActivateForFile([In] string appUserModelId, [In] object itemArray, [In] string verb, [Out] out uint processId);
  int ActivateForProtocol([In] string appUserModelId, [In] object itemArray, [Out] out uint processId);
}

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager { }

public class WinProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

  public static string VisibleTitle(int pid) {
    string found = null;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid && IsWindowVisible(h)) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        if (sb.Length > 0) { found = sb.ToString(); return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Real activation path (no explorer dependency). Returns "ok" or a diagnostic note.
  public static string ActivateCom(string aumid) {
    try {
      var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
      uint pid;
      int hr = mgr.ActivateApplication(aumid, null, 0, out pid);
      return hr == 0 ? "ok (pid " + pid + ")" : "hr=0x" + hr.ToString("X8");
    } catch (Exception ex) {
      return "exception: " + ex.Message;
    }
  }
}
"@

# ---------------------------------------------------------------- extract payload
if (-not $env:RUNNER_TEMP) { $env:RUNNER_TEMP = [System.IO.Path]::GetTempPath() }
$layout = Join-Path $env:RUNNER_TEMP "msix-activation"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force -Path $layout | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $MsixPath).Path, $layout)

# Loose registration does not use these two; dropping them matches the verified
# A/B procedure and avoids blockmap mismatch complaints.
foreach ($drop in @("AppxBlockMap.xml", "[Content_Types].xml")) {
  $p = Join-Path $layout $drop
  if (Test-Path $p) { Remove-Item $p -Force }
}

$manifestPath = Join-Path $layout "AppxManifest.xml"
if (-not (Test-Path $manifestPath)) { Warn "AppxManifest.xml missing in package - activation test SKIPPED (exit 2)"; exit 2 }
[xml]$manifest = Get-Content $manifestPath -Raw -Encoding UTF8
$identityName = [string]$manifest.Package.Identity.Name
Info "package identity: $identityName"

# ---------------------------------------------------------------- enable sideloading
try {
  $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name "AllowAllTrustedApps" -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name "AllowDevelopmentWithoutDevLicense" -Value 1 -PropertyType DWord -Force | Out-Null

  Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue
  Add-AppxPackage -Register $manifestPath
  Info "registered (loose)"
} catch {
  Warn "cannot register package in this environment ($($_.Exception.Message)) - activation test SKIPPED (exit 2)"
  exit 2
}

# ---------------------------------------------------------------- resolve real AUMID
$aumid = $null
for ($i = 0; $i -lt 10 -and -not $aumid; $i++) {
  $aumid = (Get-StartApps | Where-Object { $_.AppID -like "$identityName*" } | Select-Object -First 1).AppID
  if (-not $aumid) { Start-Sleep -Seconds 2 }
}
if (-not $aumid) {
  Get-AppxPackage -Name $identityName | Remove-AppxPackage -ErrorAction SilentlyContinue
  Warn "AUMID not published for $identityName - activation test SKIPPED (environment, exit 2)"
  exit 2
}
Info "AUMID: $aumid"

# ---------------------------------------------------------------- activate and look for a visible window
# A single activation can be a false negative, so retry with a clean slate in between.
$ok = $false
$log = @()
for ($try = 1; $try -le $Attempts -and -not $ok; $try++) {
  Get-Process -Name $ExeName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
  $started = Get-Date
  $note = [WinProbe]::ActivateCom($aumid)
  if ($note -notlike "ok*") {
    Info "COM activation note: $note - falling back to shell:AppsFolder"
    Start-Process "shell:AppsFolder\$aumid"
  }
  $deadline = $started.AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $proc = Get-Process -Name $ExeName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
      $title = [WinProbe]::VisibleTitle($proc.Id)
      if ($title) {
        $ok = $true
        $log += "try ${try}: visible window '$title' after $([int]((Get-Date) - $started).TotalSeconds)s (activate: $note)"
        break
      }
    }
  }
  if (-not $ok) {
    $alive = @(Get-Process -Name $ExeName -ErrorAction SilentlyContinue).Count
    $log += "try ${try}: NO visible window (payload processes alive: $alive; activate: $note)"
  }
}

Get-Process -Name $ExeName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-AppxPackage -Name $identityName | Remove-AppxPackage -ErrorAction SilentlyContinue

$log | ForEach-Object { Info $_ }
if (-not $ok) {
  throw ("AUMID activation never produced a visible main window in $Attempts attempts - " +
         "this is the Store certification failure 10.1.2.10 'crashes at launch'. " +
         "Check AppxManifest Application@EntryPoint == Windows.FullTrustApplication " +
         "(and the appExecutionAlias extension EntryPoint as well).")
}
Info "activation smoke: PASS"
