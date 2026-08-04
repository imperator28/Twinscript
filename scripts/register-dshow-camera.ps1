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
$dll = Join-Path $ReleaseDir 'twinscript-dshow-camera.dll'

$clsid = '{1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}'
$categoryInstance =
  "HKLM:\SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\$clsid"
$comServer = "HKLM:\SOFTWARE\Classes\CLSID\$clsid\InprocServer32"

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

function Show-Status {
  Write-Output '--- status ---'
  Write-Output "  COM server:     $(if (Test-Path $comServer) { (Get-ItemProperty $comServer).'(default)' } else { 'not registered' })"
  $listed = Test-Path $categoryInstance
  Write-Output "  camera list:    $(if ($listed) { (Get-ItemProperty $categoryInstance).FriendlyName } else { 'not registered' })"
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

if ($Action -eq 'Status') {
  Write-Output "dll: $dll  (present: $(Test-Path -LiteralPath $dll))"
  Show-Status
  exit 0
}

if (-not (Test-Path -LiteralPath $dll)) {
  Write-Output "ABORT  not found: $dll"
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
  Write-Output "installing $dll"
  $null = Start-Process regsvr32.exe -ArgumentList '/s', '/n', '/i:machine', $dll -Wait -PassThru -NoNewWindow
} else {
  Write-Output "removing $dll"
  $null = Start-Process regsvr32.exe -ArgumentList '/s', '/u', '/n', '/i:machine', $dll -Wait -PassThru -NoNewWindow
}

Write-Output ''
Show-Status

Write-Output ''
$log = 'C:\ProgramData\Twinscript\logs\dshow-camera.log'
if (Test-Path $log) {
  Write-Output '--- last log lines ---'
  Get-Content $log -Tail 4 | ForEach-Object { "  " + ($_ -split '\| ')[-1] }
}

if ($Action -eq 'Install' -and (Test-Path $categoryInstance)) {
  Write-Output ''
  Write-Output 'Next: open the Teams camera picker. "Twinscript" should be listed.'
  Write-Output 'It will NOT show a picture yet - the output pin is W6.2.'
}
