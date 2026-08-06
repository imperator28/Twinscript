<#
.SYNOPSIS
Install, remove, or inspect the DirectShow virtual camera. Must run ELEVATED to
install or remove.

.DESCRIPTION
A DirectShow capture filter needs two registrations, and IFilterMapper2 writes the
device-category half under HKEY_CLASSES_ROOT, which resolves to HKLM. So this
always needs administrator - the same reason OBS ships an elevated installer.

Milestone W6.1 is deliberately checkable on its own: after Install, "Twinscript"
should appear in the Teams camera list. It will not show a picture yet - the output
pin arrives in W6.2. Separating those two steps is the direct correction for how
the Media Foundation attempt went wrong, where nothing was independently
observable until everything was supposedly done.

.PARAMETER Action
Install, Remove, or Status.
#>
[CmdletBinding()]
param(
  [ValidateSet('Install', 'Remove', 'Status')]
  [string]$Action = 'Status',
  [string]$ReleaseDir,
  # Set only on the relaunched, elevated copy of this script. Guards against
  # recursing forever if the elevated child somehow still is not an administrator.
  [switch]$Elevated
)

$ErrorActionPreference = 'Continue'

if (-not $ReleaseDir) {
  # Development layout first, then the packaged layout where this script sits beside
  # the DLL in resources\native-camera. Without the fallback a packaged install
  # would look for the filter in a path that only exists in a source checkout.
  $devDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'native\camera-companion\build\Release'
  $ReleaseDir =
    if (Test-Path -LiteralPath (Join-Path $devDir 'twinscript-dshow-camera.dll')) {
      $devDir
    } else {
      $PSScriptRoot
    }
}
$builtDll = Join-Path $ReleaseDir 'twinscript-dshow-camera.dll'

# The filter is NOT registered from the build tree. Unlike a Media Foundation
# source - which the Frame Server loads in its own LocalService process - a
# DirectShow filter is loaded directly INTO the consumer. Teams is a packaged MSIX
# app running in an AppContainer, so it can only load a DLL that grants
# ALL APPLICATION PACKAGES read+execute, and nothing under a user's profile does.
# The working OBS filter carries exactly that ACE; verified on this machine.
$installDir = 'C:\ProgramData\Twinscript\bin'

# Each install stages under a UNIQUE filename rather than overwriting one path.
#
# A DirectShow filter is loaded into every process that merely enumerates cameras
# - observed here in ms-teams, Slack, chrome, electron and claude itself - and each
# holds the DLL open. Overwriting a single canonical name therefore fails with a
# sharing violation and the only remedy is closing every one of those apps, which
# is not viable when one of them is the tool doing the work.
#
# Registering a fresh file each time sidesteps the lock entirely. Old copies are
# deleted best-effort; the ones still loaded are left for the next run to collect.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dllPattern = 'twinscript-dshow-camera*.dll'
$dll = Join-Path $installDir "twinscript-dshow-camera-$stamp.dll"

function Remove-StaleCopies([string]$keep) {
  Get-ChildItem -LiteralPath $installDir -Filter $dllPattern -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $keep } |
    ForEach-Object {
      # Captured before the try: inside catch, $_ is the error record, not the file.
      $name = $_.Name
      try {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
      } catch {
        Write-Output "  (still loaded, left in place: $name)"
      }
    }
}

# The registered path is the authority for Status and Remove, not the naming
# convention: the timestamp differs every run.
function Get-RegisteredDllPath {
  $key = "HKLM:\SOFTWARE\Classes\CLSID\$clsid\InprocServer32"
  if (Test-Path $key) { (Get-ItemProperty $key).'(default)' } else { $null }
}

$clsid = '{1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}'
$categoryRoot =
  'HKLM:\SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance'
$comServer = "HKLM:\SOFTWARE\Classes\CLSID\$clsid\InprocServer32"

# Find the category entry by its CLSID VALUE, never by assuming the key name.
# IFilterMapper2 chooses the instance key name, and an earlier build of this
# script assumed it equalled the CLSID - so a fully working registration was
# reported as "half-registered", which is a far more dangerous bug than a missing
# feature: it invites a fix to something that is not broken.
function Get-CategoryEntry {
  Get-ChildItem $categoryRoot -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.CLSID -eq $clsid) {
      [pscustomobject]@{
        Key          = $_.PSChildName
        FriendlyName = $p.FriendlyName
        FilterData   = $(if ($p.FilterData) { $p.FilterData.Length } else { 0 })
      }
    }
  } | Select-Object -First 1
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

function Show-Status {
  Write-Output '--- status ---'
  Write-Output "  COM server:     $(if (Test-Path $comServer) { (Get-ItemProperty $comServer).'(default)' } else { 'not registered' })"
  $entry = Get-CategoryEntry
  $listed = [bool]$entry
  if ($listed) {
    Write-Output "  camera list:    $($entry.FriendlyName)  (key '$($entry.Key)', FilterData $($entry.FilterData) bytes)"
  } else {
    Write-Output '  camera list:    not registered'
  }
  if ((Test-Path $comServer) -ne $listed) {
    Write-Output '  WARNING  half-registered. A COM server without a category entry'
    Write-Output '           enumerates from stale caches and then fails to activate.'
  }
  Write-Output '  other virtual cameras present:'
  Get-ChildItem "HKLM:\SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $name = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).FriendlyName
      if ($name) { Write-Output "    - $name" }
    }
}

function Show-PackageAccess([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $ace = (Get-Acl -LiteralPath $path).Access |
    Where-Object { $_.IdentityReference -match 'ALL APPLICATION PACKAGES' }
  if ($ace) {
    Write-Output '  AppContainer read:  granted (a packaged client such as Teams can load it)'
  } else {
    Write-Output '  AppContainer read:  MISSING - a packaged client cannot load this DLL'
  }
}

if ($Action -eq 'Status') {
  $registered = Get-RegisteredDllPath
  Write-Output "registered dll: $(if ($registered) { $registered } else { '(none)' })"
  if ($registered) {
    Write-Output "                present on disk: $(Test-Path -LiteralPath $registered)"
    Show-PackageAccess $registered
  }
  Write-Output "built dll:      $builtDll  (present: $(Test-Path -LiteralPath $builtDll))"
  $copies = @(Get-ChildItem -LiteralPath $installDir -Filter $dllPattern -ErrorAction SilentlyContinue)
  if ($copies.Count -gt 1) {
    Write-Output "  $($copies.Count) staged copies present (older ones are still loaded by some process)"
  }
  Show-Status
  exit 0
}

# Install needs a filter to stage; Remove does not - it unregisters through the
# path recorded in the registry, so a half-uninstalled machine whose DLL is
# already gone stays recoverable instead of being stuck registered forever.
if ($Action -eq 'Install' -and -not (Test-Path -LiteralPath $builtDll)) {
  Write-Output "ABORT  not found: $builtDll"
  Write-Output '       Build first:'
  Write-Output '       cmake --build native/camera-companion/build --config Release --target dshow_camera'
  exit 2
}
# REQUEST elevation rather than merely requiring it.
#
# Install and Remove write the device-category registration under
# HKEY_CLASSES_ROOT, which resolves to HKLM, so they need administrator. The app
# spawns this script with its own non-elevated token, so a script that only
# *checks* for admin can never succeed from the UI - it aborted with exit 2 and
# the operator saw "Native camera action failed (exit 2)" with no way forward.
# The retired install-native-camera.ps1 self-elevated exactly like this; moving to
# this script dropped that step.
#
# Placed after the Status early-exit (read-only, must never prompt) and after the
# built-DLL check (a missing filter should report without a pointless UAC prompt).
if (-not $isAdmin -and -not $Elevated) {
  Write-Output 'requesting administrator approval'
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  # Every path is quoted: the development ReleaseDir contains a space.
  $childArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action {1} -ReleaseDir "{2}" -Elevated' -f
    $PSCommandPath, $Action, $ReleaseDir
  try {
    $child = Start-Process -FilePath $powershell -ArgumentList $childArgs `
      -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
    exit $child.ExitCode
  } catch [System.ComponentModel.Win32Exception] {
    # 1223 is ERROR_CANCELLED: the operator dismissed the UAC prompt. Reported as
    # a distinct code so the app can say "approval was canceled" instead of
    # "failed", which are different things to a user.
    if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }
    throw
  }
}
if (-not $isAdmin) {
  Write-Output 'ABORT  not elevated. The device-category registration is written under'
  Write-Output '       HKEY_CLASSES_ROOT, which resolves to HKLM. Re-run as Administrator.'
  exit 2
}

# regsvr32 /n suppresses DllRegisterServer and /i calls DllInstall, so the hive
# choice stays in one place inside the DLL. Its exit code is not trustworthy, so
# the registry is inspected afterwards instead of relying on it.
if ($Action -eq 'Install') {
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null

  # Unregister whatever is currently registered before pointing the CLSID at a new
  # file, so there is never a moment where the category entry names a stale path.
  $previous = Get-RegisteredDllPath
  if ($previous) {
    Write-Output "unregistering previous $previous"
    $null = Start-Process regsvr32.exe -ArgumentList '/s', '/u', '/n', '/i:machine', $previous -Wait -PassThru -NoNewWindow
  }

  Write-Output "staging  $builtDll"
  Write-Output "      -> $dll"
  try {
    Copy-Item -LiteralPath $builtDll -Destination $dll -Force -ErrorAction Stop
  } catch {
    Write-Output "ABORT  could not write $dll"
    Write-Output "       $($_.Exception.Message)"
    exit 2
  }

  # Match the ACEs the working OBS filter carries. icacls is used rather than
  # Set-Acl because these two SIDs have no friendly name that resolves reliably
  # across locales: S-1-15-2-1 is ALL APPLICATION PACKAGES and S-1-15-2-2 is
  # ALL RESTRICTED APPLICATION PACKAGES.
  Write-Output 'granting AppContainer read access to the filter'
  foreach ($sid in '*S-1-15-2-1', '*S-1-15-2-2') {
    $null = icacls $dll /grant "${sid}:(RX)" 2>&1
  }
  Show-PackageAccess $dll

  # The frame region needs the same treatment, and for the same reason. The filter
  # maps it from inside the consumer process, so an AppContainer client like Teams
  # must be able to read the file - otherwise the camera streams a neutral slate
  # forever while the app publishes happily to a region nobody can see.
  #
  # Inheritable on the directory (/T applies to existing children) so a region file
  # recreated by a later session is still readable without reinstalling.
  $runtimeDir = 'C:\ProgramData\Twinscript\runtime'
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  Write-Output 'granting AppContainer read access to the frame region'
  foreach ($sid in '*S-1-15-2-1', '*S-1-15-2-2') {
    $null = icacls $runtimeDir /grant "${sid}:(OI)(CI)(RX)" /T /C 2>&1
  }
  Show-PackageAccess $runtimeDir

  Write-Output "registering $dll"
  $null = Start-Process regsvr32.exe -ArgumentList '/s', '/n', '/i:machine', $dll -Wait -PassThru -NoNewWindow
  Remove-StaleCopies $dll
} else {
  # Unregister through the path that is actually registered, not a name guessed
  # from the convention: the staged filename carries a timestamp.
  $registered = Get-RegisteredDllPath
  $target = if ($registered) { $registered } else { $builtDll }
  Write-Output "removing registration for $target"
  $null = Start-Process regsvr32.exe -ArgumentList '/s', '/u', '/n', '/i:machine', $target -Wait -PassThru -NoNewWindow
  Remove-StaleCopies ''
}

Write-Output ''
Show-Status

Write-Output ''
$log = 'C:\ProgramData\Twinscript\logs\dshow-camera.log'
if (Test-Path $log) {
  Write-Output '--- last log lines ---'
  Get-Content $log -Tail 4 | ForEach-Object { "  " + ($_ -split '\| ')[-1] }
}

if ($Action -eq 'Install' -and (Get-CategoryEntry)) {
  Write-Output ''
  Write-Output 'Next: quit Teams FULLY (it caches the device list), reopen, and select'
  Write-Output '"Twinscript" in the camera picker.'
  Write-Output '  a colour cycling every few seconds -> the pin is streaming.'
  Write-Output '  a single static colour              -> one frame arrived, then stalled.'
  Write-Output '  black or an error                   -> connection failed; check'
  Write-Output '    C:\ProgramData\Twinscript\logs\dshow-camera.log for the last call.'
}
