<#
.SYNOPSIS
Hold the native virtual camera open with a moving test pattern so a real meeting
client can be pointed at it. Must be run from an ELEVATED PowerShell.

.DESCRIPTION
This is the ONLY check that tests the path a meeting client uses.

`vcam-host drive`, `selftest`, and the reference control harness all activate the
media source in-process through the registered CLSID, which bypasses the Windows
Frame Server entirely. They streamed perfectly for weeks while every meeting
client showed a blank feed, because they were never exercising the broken path.
Established by instrumenting Microsoft's reference camera: while Teams was
successfully consuming it, the DLL was loaded only in the process that called
MFCreateVirtualCamera - never in a Frame Server process.

So: this script installs the freshly built source, registers it, creates the
camera, and then just holds it. You point Teams (or the Windows Camera app) at
"Twinscript" and look.

TWINSCRIPT_VCAM_SYNTHETIC is set so the source generates its own moving test
pattern. Without it the source reads the shared stage region, which is empty
unless the app is running a camera session - and an empty region is black, which
would be indistinguishable from the failure being investigated.

.PARAMETER ReleaseDir
Build output holding vcam-host.exe and the source DLL. Resolved relative to this
script, because an elevated shell starts in C:\Windows\system32.
#>
[CmdletBinding()]
param(
  [string]$ReleaseDir
)

$ErrorActionPreference = 'Continue'

if (-not $ReleaseDir) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $ReleaseDir = Join-Path $repoRoot 'native\camera-companion\build\Release'
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Output 'Twinscript native camera - hold open for a real client'
Write-Output "elevated: $isAdmin   user: $($id.Name)"
Write-Output ''

$hostExe = Join-Path $ReleaseDir 'vcam-host.exe'
$sourceDll = Join-Path $ReleaseDir 'twinscript-vcam-source.dll'
foreach ($required in $hostExe, $sourceDll) {
  if (-not (Test-Path -LiteralPath $required)) {
    Write-Output "ABORT  not found: $required"
    Write-Output '       Build first: cmake --build native/camera-companion/build --config Release'
    exit 2
  }
}
Write-Output "host: $hostExe"
Write-Output ("source DLL: {0:N0} bytes, built {1}" -f `
  (Get-Item $sourceDll).Length, (Get-Item $sourceDll).LastWriteTime)
Write-Output ''

if (-not $isAdmin) {
  Write-Output 'ABORT  not elevated. The Frame Server runs as NT AUTHORITY\LocalService'
  Write-Output '       and cannot read HKCU, so the CLSID must live in HKLM.'
  exit 2
}

$registered = $false
try {
  Write-Output '--- register the freshly built source under HKLM ---'
  & $hostExe register-machine
  if ($LASTEXITCODE -ne 0) { throw 'HKLM registration failed' }
  $registered = $true
  & $hostExe status-machine
  Write-Output ''

  Write-Output '--- create the camera and hold it open ---'
  Write-Output '    Select "Twinscript" in Teams or the Windows Camera app now.'
  Write-Output '      moving pattern -> the Frame Server is streaming our source. Fixed.'
  Write-Output '      black          -> still not served; the sensor profile was not enough.'
  Write-Output ''
  # Process-scoped, and the source is created in THIS process, so it applies.
  $env:TWINSCRIPT_VCAM_SYNTHETIC = '1'
  & $hostExe camera 0
} catch {
  Write-Output "ERROR  $($_.Exception.Message)"
} finally {
  if ($registered) {
    Write-Output ''
    Write-Output '--- cleanup ---'
    & $hostExe unregister-machine
    $inproc = 'HKLM:\Software\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}\InprocServer32'
    if (Test-Path $inproc) {
      Write-Output '  CLEANUP FAILED - still registered at:'
      Write-Output "    $((Get-ItemProperty $inproc).'(default)')"
      Write-Output "  Remove with:  & '$hostExe' unregister-machine"
    } else {
      Write-Output '  ok    HKLM registration removed'
    }
  }
}
