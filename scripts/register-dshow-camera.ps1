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
  [string]$ReleaseDir
)

$ErrorActionPreference = 'Continue'

if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'native\camera-companion\build\Release'
}
$builtDll = Join-Path $ReleaseDir 'twinscript-dshow-camera.dll'

# The filter is NOT registered from the build tree. Unlike a Media Foundation
# source - which the Frame Server loads in its own LocalService process - a
# DirectShow filter is loaded directly INTO the consumer. Teams is a packaged MSIX
# app running in an AppContainer, so it can only load a DLL that grants
# ALL APPLICATION PACKAGES read+execute, and nothing under a user's profile does.
# The working OBS filter carries exactly that ACE; verified on this machine.
$installDir = 'C:\ProgramData\Twinscript\bin'
$dll = Join-Path $installDir 'twinscript-dshow-camera.dll'

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
  Write-Output "installed dll: $dll  (present: $(Test-Path -LiteralPath $dll))"
  Write-Output "built dll:     $builtDll  (present: $(Test-Path -LiteralPath $builtDll))"
  Show-PackageAccess $dll
  Show-Status
  exit 0
}

if (-not (Test-Path -LiteralPath $builtDll)) {
  Write-Output "ABORT  not found: $builtDll"
  Write-Output '       Build first:'
  Write-Output '       cmake --build native/camera-companion/build --config Release --target dshow_camera'
  exit 2
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
  Write-Output "staging  $builtDll"
  Write-Output "      -> $dll"
  try {
    Copy-Item -LiteralPath $builtDll -Destination $dll -Force -ErrorAction Stop
  } catch {
    Write-Output "ABORT  could not replace $dll"
    Write-Output "       $($_.Exception.Message)"
    Write-Output '       A consumer still has the filter loaded. Close Teams and retry.'
    exit 2
  }

  # Match the ACEs the working OBS filter carries. icacls is used rather than
  # Set-Acl because these two SIDs have no friendly name that resolves reliably
  # across locales: S-1-15-2-1 is ALL APPLICATION PACKAGES and S-1-15-2-2 is
  # ALL RESTRICTED APPLICATION PACKAGES.
  Write-Output 'granting AppContainer read access'
  foreach ($sid in '*S-1-15-2-1', '*S-1-15-2-2') {
    $null = icacls $dll /grant "${sid}:(RX)" 2>&1
  }
  Show-PackageAccess $dll

  Write-Output "registering $dll"
  $null = Start-Process regsvr32.exe -ArgumentList '/s', '/n', '/i:machine', $dll -Wait -PassThru -NoNewWindow
} else {
  if (-not (Test-Path -LiteralPath $dll)) {
    Write-Output "  nothing installed at $dll; removing registration anyway"
  }
  Write-Output "removing $dll"
  $null = Start-Process regsvr32.exe -ArgumentList '/s', '/u', '/n', '/i:machine', $dll -Wait -PassThru -NoNewWindow
  Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue
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
  Write-Output 'Next: open the Teams camera picker. "Twinscript" should be listed.'
  Write-Output 'It will NOT show a picture yet - the output pin is W6.2.'
  Write-Output 'Teams caches its device list, so quit it fully and reopen before judging.'
}
